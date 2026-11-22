-- offline net_agent v5: introspect GameDef at runtime, return real SUCCESS
print("[OFFLINE] net_agent source stub v5")
local NetAgent = {}
_ENV.NetAgent = NetAgent
NetAgent.SERVER_LIST = {}
NetAgent.logined = false
NetAgent.logining = false
NetAgent.proto_handle_list = {}
NetAgent.send_callback_list = {}
NetAgent.pending = {}

function NetAgent:Init(...)
  print("[OFFLINE] NetAgent:Init")
  local self_ref = self
  local ok = pcall(function()
    self_ref.update_id = _ENV.World:RegistUpdate(function() self_ref:Update() end)
  end)
  print("[OFFLINE] World:RegistUpdate(fn) ok=" .. tostring(ok))
  if not ok then
    local ok2 = pcall(function() _ENV.World:RegistUpdate(self_ref, self_ref.Update) end)
    print("[OFFLINE] World:RegistUpdate(self,fn) ok=" .. tostring(ok2))
    if not ok2 then
      local ok3 = pcall(function()
        _ENV.FrameTimer:RegistTimer(1, function() self_ref:Update() end)
      end)
      print("[OFFLINE] FrameTimer fallback ok=" .. tostring(ok3))
    end
  end
end
function NetAgent:IsServerList() return 0 end
function NetAgent:IsServerUrlLoaded() return 1 end
function NetAgent:GetServerList() return {} end
function NetAgent:IsConnecting() return 0 end
function NetAgent:GetNetworkDelayDisplay() return "0" end
function NetAgent:RequestServerRoute(...) end
function NetAgent:Connect(...) end
function NetAgent:Update(...)
  local n = #self.pending
  if n == 0 then return end
  local queued = self.pending
  self.pending = {}
  for i = 1, n do
    local item = queued[i]
    local ok, err = xpcall(item.cb, debug.traceback, item.res)
    if not ok then print("[OFFLINE] deferred cb error [" .. tostring(item.tag) .. "]: " .. tostring(err)) end
  end
end
function NetAgent:Reset(...) end
function NetAgent:AddConnectingFilterProto(...) end
function NetAgent:ClearProtoCallback(...) end
function NetAgent:RegServerRequestHandler(...) end
-- Native LuaManager registers one CSCallback; responses to SendRequest4CS
-- are delivered to it as (session, res), as in the stock CSProtoCallback.
function NetAgent:RegistRequestCallback(handler) self.cs_callback = handler end
function NetAgent:sendSproto(...) end
function NetAgent:ApplyDisconnect(...) end
function NetAgent:OnServerDisconnect(...) end

-- Diagnostic only: every field the client reads that the offline response
-- does not define is logged as MISSING so it can be given an explicit shape.
local function autoviv(tag)
  local mt
  mt = { __index = function(t, k)
    local path = rawget(t, "\0path") or tag
    local full = path .. "." .. tostring(k)
    print("[OFFLINE] MISSING " .. full)
    local v = setmetatable({ ["\0path"] = full }, mt)
    rawset(t, k, v)
    return v
  end }
  return setmetatable({ ["\0path"] = tag }, mt)
end

local function ser(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "number" or t == "boolean" then return tostring(v) end
  if t == "string" then return string.format("%q", v) end
  if t ~= "table" or depth > 12 then return "nil" end
  local parts = {}
  for k, val in pairs(v) do
    local key
    if type(k) == "number" then key = "[" .. tostring(k) .. "]"
    else key = "[" .. string.format("%q", tostring(k)) .. "]" end
    parts[#parts + 1] = key .. "=" .. ser(val, depth + 1)
  end
  return "{" .. table.concat(parts, ",") .. "}"
end
local function show(x)
  if type(x) ~= "table" then return tostring(x) end
  local p = {}
  for k, v in pairs(x) do p[#p+1] = tostring(k) .. "=" .. show(v) end
  table.sort(p); return "{" .. table.concat(p, ",") .. "}"
end
-- RemoteModuleBase.Init builds key_enum = Utils.genKeyIndex(init_data) and
-- setData maps server data back with SyncIndex2Key, so the server ships
-- module data index-keyed. Pick the Key2Index argument order that
-- roundtrips through Index2Key instead of assuming it.
local function same(x, y)
  if type(x) ~= type(y) then return false end
  if type(x) ~= "table" then return x == y end
  for k, v in pairs(x) do if not same(v, y[k]) then return false end end
  for k in pairs(y) do if x[k] == nil then return false end end
  return true
end
local function encode(data, en)
  local U = _ENV.Utils
  en = en or U.genKeyIndex(data)
  for _, order in ipairs({1, 2}) do
    local ok, ix = pcall(function()
      if order == 1 then return U.Key2Index(data, en) end
      return U.Key2Index(en, data)
    end)
    if ok and type(ix) == "table" then
      local ok2, back = pcall(function()
        if order == 1 then return U.Index2Key(ix, en) end
        return U.Index2Key(en, ix)
      end)
      if ok2 and same(back, data) then return ix, order end
    end
  end
  return nil, 0
end

-- Server responses carry module updates in sync_list: a Lua literal
-- {[ModuleDef.SYNC index] = data index-keyed with that module's key_enum},
-- which net_agent hands to RemoteModuleMgr via Event "SYNC_SERVER_DATA"
-- before the request callback runs (stock net_agent.lua:656).
local function fireSync(agent, partials)
  if type(partials) ~= "table" then return end
  local md, mgr = _ENV.ModuleDef, _ENV.RemoteModuleMgr
  local out, n = {}, 0
  for i, m in ipairs(md.SYNC) do
    local part = partials[m.name]
    if part ~= nil then
      local mod = mgr and mgr:GetModuleByIndex(i)
      local en = mod and mod.key_enum
      local ix = encode(part, en)
      if ix == nil then
        print("[OFFLINE] sync " .. tostring(m.name) .. " does not roundtrip; skipped")
      else
        out[i] = ix; n = n + 1
      end
    end
  end
  if n == 0 then return end
  local literal = ser(out)
  print("[OFFLINE] SYNC_SERVER_DATA " .. literal)
  _ENV.Event:FireEvent(agent, "SYNC_SERVER_DATA", literal)
end

local function protoCode(name, fallback)
  local gd = _ENV.GameDef
  if type(gd) == "table" and type(gd.PROTO_CODE) == "table" and gd.PROTO_CODE[name] ~= nil then
    return gd.PROTO_CODE[name]
  end
  return fallback
end

-- Responses with a shape taken from proto_def and the caller's own request.
-- Anything not listed gets the client's own "not connected" answer,
-- {ret_code = PROTO_CODE.OFFLINE}, which the stock net_agent sends to every
-- pending callback on disconnect; no fields are invented for it.
local RESPONSES = {
  -- CHECK_SERVER_CONFIG response { result 0 : *DictionaryStr }: no overrides.
  ["BASE.CHECK_SERVER_CONFIG"] = function(data)
    return { ret_code = protoCode("SUCCESS", 1), result = {} }
  end,
  -- APPLY_INT response { result 0 : integer } / APPLY_STR { result 0 : string }.
  -- login_mgr reads only ret_code and result; these keys are registration
  -- bookkeeping (reg_pkv / regt) with no local meaning.
  ["BASE.APPLY_INT"] = function(data)
    return { ret_code = protoCode("SUCCESS", 1), result = 0 }
  end,
  ["BASE.APPLY_STR"] = function(data)
    return { ret_code = protoCode("SUCCESS", 1), result = "" }
  end,
  -- query_data passes res.data through str2lua, so data must be a Lua table
  -- literal string. Empty table = "nothing available offline", which each
  -- caller already handles (it is also what an empty server pool returns).
  ["QUERY.ACHIEVEMENT"] = function() return { ret_code = protoCode("SUCCESS", 1), data = "{}" } end,
  ["QUERY.SYNC_ACTIVITY"] = function() return { ret_code = protoCode("SUCCESS", 1), data = "{}" } end,
  ["QUERY.LOTTERY"] = function() return { ret_code = protoCode("SUCCESS", 1), data = "{}" } end,
  ["QUERY.DYNAMIC_SHOP"] = function() return { ret_code = protoCode("SUCCESS", 1), data = "{}" } end,
  ["QUERY.EQUIP_DYNAMIC_POOL"] = function() return { ret_code = protoCode("SUCCESS", 1), data = "{}" } end,
  -- query_data iterates res.result as a list of invitee records.
  ["QUERY.INVITEE"] = function() return { ret_code = protoCode("SUCCESS", 1), result = {} } end,
  -- SERVER_PATCH response { version, patch, config_version, configs }:
  -- echo the client's current versions, i.e. "nothing to patch".
  -- proto_def BASE.CUSTOM_UPDATE 5: response { ret_code 0 : integer }
  ["BASE.CUSTOM_UPDATE"] = function()
    return { ret_code = protoCode("SUCCESS", 1) }
  end,

  -- BATTLE.START (stage_id, stage_level, equips, params). The callback
  -- (battle_module.lua:405-409) reads BATTLE data "stage" and "rid", and the
  -- battle scene resolves rid as a RoomConfig id (RoomMgr.LoadRoom logs
  -- "No config id: RoomConfig <rid>" otherwise). The server's answer is a
  -- BATTLE sync: stage, the first room of the stage's roomList
  -- (ConfigMgr:GetRoomId(stage, 1)), room = rooms entered so far, time.
  ["BATTLE.START"] = function(data)
    data = type(data) == "table" and data or {}
    local stage = tostring(data.stage_id or "")
    return { ret_code = protoCode("SUCCESS", 1) }, {
      BATTLE = { stage = stage, rid = _ENV.ConfigMgr:GetRoomId(stage, 1) or "", room = 1, time = 0 },
    }
  end,
  -- BATTLE.ENTER_ROOM (battle_module.lua:238-272) sends stage_id, the
  -- 1-based room_index it is entering, and the elapsed time; it only sends
  -- when room_index > BATTLE.room and its callback reads BATTLE "rid".
  ["BATTLE.ENTER_ROOM"] = function(data)
    data = type(data) == "table" and data or {}
    local stage = tostring(data.stage_id or "")
    local index = tonumber(data.room_index) or 1
    return { ret_code = protoCode("SUCCESS", 1) }, {
      BATTLE = { stage = stage, rid = _ENV.ConfigMgr:GetRoomId(stage, index) or "", room = index, time = tonumber(data.time) or 0 },
    }
  end,

  ["BASE.SERVER_PATCH"] = function(data)
    data = type(data) == "table" and data or {}
    return {
      ret_code       = protoCode("SUCCESS", 1),
      version        = data.patch_version or 0,
      patch          = "",
      config_version = data.patch_config_version or 0,
      configs        = {},
    }
  end,
}

local function offlineResponse(group, name, data)
  local tag = tostring(group) .. "." .. tostring(name)
  local build = RESPONSES[tag]
  if build then
    local res, sync = build(data)
    return res, true, sync
  end
  print("[OFFLINE] UNRESOLVED " .. tag .. " -> ret_code=OFFLINE")
  return { ret_code = protoCode("OFFLINE", -1) }, false
end

function NetAgent:SendRequest(group, name, data, cb)
  print("[OFFLINE] SendRequest group=" .. tostring(group) .. " name=" .. tostring(name))
  local res, _, sync = offlineResponse(group, name, data)
  local agent = self
  -- the caller publishes SERVER_RESPONSE from this callback and only then
  -- waits on it, so delivering inline drops the message ("Wait nil But
  -- Receive SERVER_RESPONSE"). Defer to the next tick.
  self.pending[#self.pending + 1] = {
    res = res, tag = tostring(group) .. "." .. tostring(name),
    cb = function(r) fireSync(agent, sync); if cb then cb(r) end end,
  }
  return res
end
-- Mirrors stock net_agent.lua:544-553 and CSProtoCallback (508-513):
-- the session handed back to C# is the pre-increment counter (starting at 1)
-- and the native CSCallback reads the session as its first (integer) arg
-- (LuaHelper.GetInt(1) fails on a table there), then the response.
function NetAgent:SendRequest4CS(group, name, args)
  print("[OFFLINE] SendRequest4CS group=" .. tostring(group) .. " name=" .. tostring(name))
  if type(args) == "table" then
    for k, v in pairs(args) do print("[OFFLINE]   arg " .. tostring(k) .. " = " .. tostring(v)) end
  else print("[OFFLINE]   args " .. type(args) .. " " .. tostring(args)) end
  local session = self.cs_session or 1
  self.cs_session = session + 1
  local res, _, sync = offlineResponse(group, name, args)
  local agent = self
  self.pending[#self.pending + 1] = {
    tag = tostring(group) .. "." .. tostring(name) .. "#cs",
    res = res,
    cb = function(r)
      fireSync(agent, sync)
      if agent.cs_callback then agent.cs_callback(session, r)
      else print("[OFFLINE] no cs_callback for session " .. session) end
    end,
  }
  return session
end

local function dumpTable(label, t)
  if type(t) ~= "table" then print("[OFFLINE] " .. label .. " is " .. type(t)); return end
  local n = 0
  for k, v in pairs(t) do
    print("[OFFLINE] " .. label .. "." .. tostring(k) .. " = " .. tostring(v))
    n = n + 1
    if n > 60 then break end
  end
end

function NetAgent:Login(...)
  print("[OFFLINE] NetAgent:Login (v5)")
  local gd = _ENV.GameDef
  print("[OFFLINE] GameDef is " .. type(gd))
  local success = 1
  if type(gd) == "table" then
    print("[OFFLINE] IS_COMPRESS = " .. tostring(gd.IS_COMPRESS))
    dumpTable("LOGIN_RESULT", gd.LOGIN_RESULT)
    if type(gd.LOGIN_RESULT) == "table" and gd.LOGIN_RESULT.SUCCESS ~= nil then
      success = gd.LOGIN_RESULT.SUCCESS
    end
  end
  print("[OFFLINE] using login_result = " .. tostring(success))

  -- role_data: the client's own new-player defaults from ModuleDef.SYNC,
  -- serialized as a plain data literal (str2lua loads it in a sandbox, so it
  -- must not call functions).
  do
    local sample = {aa=1, bb={x=2}, cc="s"}
    local ix, order = encode(sample)
    print("[OFFLINE] probe en=" .. show(_ENV.Utils.genKeyIndex(sample)) .. " ix=" .. show(ix) .. " order=" .. order)
  end
  if type(_ENV.GameDef) == "table" then dumpTable("GameDef.PROTO_CODE", _ENV.GameDef.PROTO_CODE) end
  local U = _ENV.Utils
  local profile = {}
  local md = _ENV.ModuleDef
  if type(md) == "table" and type(md.SYNC) == "table" then
    for i, m in ipairs(md.SYNC) do
      local keys = {}
      if type(m.data) == "table" then for k in pairs(m.data) do keys[#keys + 1] = tostring(k) end end
      print("[OFFLINE] SYNC[" .. i .. "] name=" .. tostring(m.name) .. " script=" .. tostring(m.script) ..
            " version=" .. tostring(m.version) .. " data_keys=" .. table.concat(keys, ","))
      local data = m.data or {}
      local ix, order = encode(data)
      if ix == nil then
        print("[OFFLINE] SYNC[" .. i .. "] " .. tostring(m.name) .. " UNENCODED (no roundtrip)")
        ix = data
      end
      profile[i] = ix
    end
  else
    print("[OFFLINE] ModuleDef.SYNC missing: " .. type(md))
  end
  local literal = ser(profile)
  print("[OFFLINE] role_data literal bytes=" .. #literal .. " head=" .. string.sub(literal, 1, 120))
  local role = ""
  local ok, packed = pcall(function()
    if _ENV.Compressor and _ENV.Compressor.Compress then
      return _ENV.Compressor:Compress(literal)
    end
    return literal
  end)
  if ok and type(packed) == "string" then role = packed end
  print("[OFFLINE] role_data bytes = " .. tostring(#role))

  self.logined = true
  return {
    login_result    = success,
    role_data       = role,
    server_timezone = 0,
    server_time     = 0,
    uid             = 1,
    new_day         = false,
    param           = 0,
    oid             = "offline",
    session         = "offline",
    gid             = "1",
    reg             = false,
  }
end
return NetAgent
