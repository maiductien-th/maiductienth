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
    local ok, err = pcall(item.cb, item.res)
    if not ok then print("[OFFLINE] deferred cb error: " .. tostring(err)) end
  end
end
function NetAgent:Reset(...) end
function NetAgent:AddConnectingFilterProto(...) end
function NetAgent:ClearProtoCallback(...) end
function NetAgent:RegServerRequestHandler(...) end
function NetAgent:RegistRequestCallback(...) end
function NetAgent:sendSproto(...) end
function NetAgent:ApplyDisconnect(...) end
function NetAgent:OnServerDisconnect(...) end

local function autoviv()
  local mt
  mt = { __index = function(t, k)
    local v = setmetatable({}, mt)
    rawset(t, k, v)
    return v
  end }
  return setmetatable({}, mt)
end

local function offlineResponse(group, name)
  local g, n = tostring(group), tostring(name)
  local res = autoviv()
  if n == "CHECK_SERVER_CONFIG" or n == "REQUIRE_SERVER_CONFIG" or g == "CHECK_SERVER_CONFIG" then
    res.check_result      = {}
    res.config            = ""
    res.system_mail       = {}
    res.broadcast         = {}
    res.skin_open_list    = {}
    res.define            = {}
    res.battle_pass_time  = {}
    res.activity_chest    = {}
  end
  res.ret_code = 0
  res.result   = {}
  res.list     = {}
  return res
end

function NetAgent:SendRequest(group, name, data, cb)
  print("[OFFLINE] SendRequest group=" .. tostring(group) .. " name=" .. tostring(name))
  local res = offlineResponse(group, name)
  -- the caller publishes SERVER_RESPONSE from this callback and only then
  -- waits on it, so delivering inline drops the message ("Wait nil But
  -- Receive SERVER_RESPONSE"). Defer to the next tick.
  if cb then self.pending[#self.pending + 1] = { cb = cb, res = res } end
  return res
end
function NetAgent:SendRequest4CS(group, name, ...)
  print("[OFFLINE] SendRequest4CS group=" .. tostring(group) .. " name=" .. tostring(name))
  return offlineResponse(group, name)
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

  -- role_data is a deflate-compressed Lua table literal that every client
  -- module reads a slice of. An empty table makes them index nil, so ship a
  -- table that creates nested tables on demand.
  local AUTOVIV = "setmetatable({},{__index=function(t,k) " ..
                  "local v=setmetatable({},getmetatable(t)) " ..
                  "rawset(t,k,v) return v end})"
  local role = ""
  local ok, packed = pcall(function()
    if _ENV.Compressor and _ENV.Compressor.Compress then
      return _ENV.Compressor:Compress(AUTOVIV)
    end
    return AUTOVIV
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
