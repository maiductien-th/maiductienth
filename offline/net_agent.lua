-- Offline replacement for net/net_agent.lua: answers client requests from
-- local state saved under the app's files dir; nothing goes over the network.
local NetAgent = {}
_ENV.NetAgent = NetAgent
-- the stock net_agent loads ProtoGenerator via net.sproto_helper -> proto; battle_module needs the global
local okPG, errPG = pcall(require, "proto_generator")
if not okPG then print("[OFFLINE] proto_generator load failed: " .. tostring(errPG)) end
NetAgent.SERVER_LIST = {}
NetAgent.logined = false
NetAgent.logining = false
NetAgent.proto_handle_list = {}
NetAgent.send_callback_list = {}
NetAgent.pending = {}

function NetAgent:Init(...)
  local self_ref = self
  local ok = pcall(function()
    self_ref.update_id = _ENV.World:RegistUpdate(function() self_ref:Update() end)
  end)
  if not ok then
    local ok2 = pcall(function() _ENV.World:RegistUpdate(self_ref, self_ref.Update) end)
    if not ok2 then
      pcall(function()
        _ENV.FrameTimer:RegistTimer(1, function() self_ref:Update() end)
      end)
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

local function deepcopy(v)
  if type(v) ~= "table" then return v end
  local o = {}
  for k, x in pairs(v) do o[k] = deepcopy(x) end
  return o
end
local function moduleDefaults(name)
  for _, m in ipairs(_ENV.ModuleDef.SYNC) do
    if m.name == name then return deepcopy(m.data or {}) end
  end
  return {}
end
-- ECO data "d" is keyed by item id client-side (ModuleDef defaults use
-- GameDef.ITEM_ID.*), but economic_module.unzipData (lua:76-91) maps the
-- wire keys through economic_index2key, built from item config entries of
-- type "Economic" by their "index". So the wire form is keyed by index.
local function ecoZip(data)
  if type(data) ~= "table" or type(data.d) ~= "table" then return data end
  local items = _ENV.ConfigMgr and _ENV.ConfigMgr:GetConfig("item")
  if type(items) ~= "table" then return data end
  local out = {}
  for k, v in pairs(data) do out[k] = v end
  local d = {}
  for id, n in pairs(data.d) do
    local cfg = items[id]
    if type(cfg) == "table" and cfg.type == "Economic" and cfg.index ~= nil then
      d[cfg.index] = n
    else
      d[id] = n
    end
  end
  out.d = d
  return out
end
local function wire(name, data)
  if name == "ECO" then return ecoZip(data) end
  return data
end

-- Local player state: what the server would hold. Seeded from the client's
-- own ModuleDef.SYNC defaults, replaced per module on every sync, and saved
-- to the app's private files dir so it survives a restart.
local SAVE_PATH = "/data/data/com.fattoy.swordash.android/files/offline_profile.lua"
NetAgent.state = NetAgent.state or nil
local function saveState()
  if type(NetAgent.state) ~= "table" then return end
  local f = io.open(SAVE_PATH .. ".tmp", "w")
  if not f then print("[OFFLINE] save: cannot open " .. SAVE_PATH); return end
  f:write("return " .. ser(NetAgent.state))
  f:close()
  os.remove(SAVE_PATH)
  local ok = os.rename(SAVE_PATH .. ".tmp", SAVE_PATH)
  print("[OFFLINE] saved profile ok=" .. tostring(ok))
end
local function loadSaved()
  local f = io.open(SAVE_PATH, "r")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  local chunk = load(text, "offline_profile", "t", {})
  if not chunk then print("[OFFLINE] saved profile unreadable"); return nil end
  local ok, t = pcall(chunk)
  if ok and type(t) == "table" then return t end
  print("[OFFLINE] saved profile invalid")
  return nil
end
local function initState()
  local st = {}
  for _, m in ipairs(_ENV.ModuleDef.SYNC) do st[m.name] = deepcopy(m.data or {}) end
  local saved = loadSaved()
  local n = 0
  if saved then
    for name, data in pairs(saved) do
      if st[name] ~= nil and type(data) == "table" then st[name] = data; n = n + 1 end
    end
  end
  print("[OFFLINE] profile restored modules=" .. n)
  NetAgent.state = st
  return st
end
local function moduleState(name)
  local st = NetAgent.state or initState()
  return deepcopy(st[name] or {})
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
      if NetAgent.state then NetAgent.state[m.name] = deepcopy(part) end
      local mod = mgr and mgr:GetModuleByIndex(i)
      local en = mod and mod.key_enum
      local ix = encode(part, en)
      if ix == nil and type(m.data) == "table" then
        -- Keys the module never declared (e.g. GUIDE.st) have no wire index;
        -- they stay in the saved state and are resent with role_data on login.
        local known, dropped = {}, {}
        for k, v in pairs(part) do
          if m.data[k] ~= nil then known[k] = v else dropped[#dropped + 1] = tostring(k) end
        end
        if #dropped > 0 then
          ix = encode(known, en)
          if ix ~= nil then
            print("[OFFLINE] sync " .. tostring(m.name) .. " sent without undeclared keys=" .. table.concat(dropped, ","))
          end
        end
      end
      if ix == nil then
        local ks = {}
        for k in pairs(part) do ks[#ks + 1] = tostring(k) end
        print("[OFFLINE] sync " .. tostring(m.name) .. " does not roundtrip; skipped keys=" .. table.concat(ks, ","))
      else
        out[i] = ix; n = n + 1
      end
    end
  end
  if n == 0 then return end
  saveState()
  local literal = ser(out)
  _ENV.Event:FireEvent(agent, "SYNC_SERVER_DATA", literal)
end

local function addChosenTco(st, list)
  if type(list) ~= "table" then return end
  for _, e in ipairs(list) do
    if type(e) == "table" and e.key ~= nil then
      st.vi.ctl[e.key] = (st.vi.ctl[e.key] or 0) + (tonumber(e.value) or 0)
    end
  end
end

-- GUIDE.st is the last finished step (GuideModule:GetCurrentStep reads it);
-- GUIDE.gf is a bit set indexed by ConfigMgr:GetFlagIndex(flag_id), where
-- flag ids ("flag_open_box", ...) come from the finished step's guide config.
local function guideFlagIds(cfg)
  local out = {}
  if type(cfg) ~= "table" then return out end
  for k, v in pairs(cfg) do
    if type(v) == "string" then
      for id in v:gmatch("flag_[%w_]+") do out[#out + 1] = id end
    end
  end
  return out
end

local function setGuideFlags(steps)
  local g = moduleState("GUIDE")
  local gf = math.floor(tonumber(g.gf) or 0)
  local cm = _ENV.ConfigMgr
  for _, step in ipairs(type(steps) == "table" and steps or {}) do
    if step ~= nil then
      g.st = step
      local ok, cfg = pcall(function() return cm:getGuideConfig(step) end)
      cfg = ok and cfg or nil
      for _, fid in ipairs(guideFlagIds(cfg)) do
        local fok, idx = pcall(function() return cm:GetFlagIndex(fid) end)
        idx = fok and tonumber(idx) or nil
        if idx and idx >= 1 then gf = gf | (1 << (math.floor(idx) - 1)) end
      end
    end
  end
  g.gf = gf
  return g
end


-- Rewards. Config reward strings are "id|count[|arg];..." (realitem
-- UseReward, aim reward). Economic items live in ECO.d; timed items (boxes)
-- in ECO.t as {packed, acquire_time} with packed = real_id << 7 | n, parsed by
-- economic_module ParseItemValue; "gift_equip|n|<equipment key>" grants
-- equipment into EQUIP.el, keyed by tostring(euid), with DataEnum
-- "equipment" keys (base_value=1, distribution=2, attr_list=3, uuid=4,
-- link=5) and base_value = template_id << 16 | level << 8 | stars | NEW_MASK
-- (equip_module ParseEquipBaseValue).
local EQUIP_NEW_MASK = 1073741824

local function realIdOf(itemId)
  local cm = _ENV.ConfigMgr
  for rid = 1, 511 do
    local ok, id = pcall(cm.GetItemIdByRealItemId, cm, rid)
    if ok and id == itemId then return rid end
  end
  return nil
end

local function equipTemplateId(key)
  local cfgs = _ENV.ConfigMgr:GetConfig("equipment")
  if type(cfgs) ~= "table" then return nil end
  for k, v in pairs(cfgs) do
    if type(v) == "table" then
      for _, f in pairs(v) do
        if f == key then
          local id = tonumber(v.id) or tonumber(k)
          if id then return math.floor(id) end
        end
      end
    end
  end
  return nil
end

local function rewardEntries(r)
  local out = {}
  if type(r) == "string" then
    for part in r:gmatch("[^;]+") do
      local f = {}
      for x in part:gmatch("[^|]+") do f[#f + 1] = x end
      if f[1] then out[#out + 1] = { id = f[1], count = tonumber(f[2]) or 1, args = f[3] } end
    end
  elseif type(r) == "table" then
    if r.id ~= nil or type(r[1]) == "string" then r = { r } end
    for _, e in ipairs(r) do
      if type(e) == "string" then
        for _, x in ipairs(rewardEntries(e)) do out[#out + 1] = x end
      elseif type(e) == "table" then
        local id = e.id or e[1]
        if id ~= nil then
          out[#out + 1] = { id = tostring(id), count = tonumber(e.count or e[2]) or 1,
            args = e.args or e.param or e[3] }
        end
      end
    end
  end
  return out
end

-- realitem UseReward as shipped in the APK's CSV config table (assets/config.ab).
-- The zlib table in scg.ab that ConfigMgr loads omits the tutorial ULT disc from box1_1,
-- while the tutorial dialogue and guide_equip_6/7 require a second equipment item.
local REALITEM_USE_REWARD = {
  [1] = "coin|500;stone|5;gift_equip|1|Equipment_Weapon_Frontline_Tachi;gift_equip|1|Equipment_Disc_SpaceJudgement_A;box1_2|1;",
  [2] = "coin|1000;stone|5;gift_equip|1|Equipment_Armor_Frontline_Uniform;gift_equip|1|Equipment_Ornament_Frontline_Earrings;box1_3|1;",
  [3] = "coin|2000;stone|10;gift_equip|1|Equipment_Helmet_Frontline_Beret;gift_equip|1|Equipment_Shoes_Frontline_Shoes;box1_4|1;",
  [4] = "coin|3000;stone|10;key_common|3;box1_5|1;",
  [5] = "coin|4000;stone|10;key_common|2;key_adv|1;box1_6|1;",
  [6] = "coin|5000;stone|10;randomPurpleWeapon|1",
  [20] = "coin|2000;gem|10;box2_2|1;",
  [21] = "coin|4000;gem|10;box2_3|1;",
  [22] = "coin|6000;gem|10;box2_4|1;",
  [23] = "coin|8000;gem|10;box2_5|1;",
  [24] = "coin|10000;gem|20;key_adv|3;",
  [11] = "newBoxWeapon|1;box_new_2|1;",
  [12] = "newBoxArmor|1;box_new_3|1;",
  [13] = "newBoxHelmet|1;box_new_4|1;",
  [14] = "newBoxShoes|1;box_new_5|1;",
  [15] = "newBoxOrnament|1;box_new_6|1;",
  [16] = "newBoxDisk|1;",
  [31] = "box_weekly_reward|1;box_weekly_2|1;",
  [32] = "box_weekly_reward|1;box_weekly_3|1;",
  [33] = "box_weekly_reward|1;box_weekly_4|1;",
  [34] = "box_weekly_reward|1;box_weekly_5|1;",
  [35] = "box_weekly_reward|1;box_weekly_6|1;",
  [36] = "box_weekly_reward|1;box_weekly_7|1;",
  [37] = "box_weekly_reward|1",
  [100] = "randomPet|1",
  [101] = "pet|1|1",
  [102] = "randomPet|1",
  [200] = "_ec_50|3",
  [201] = "_ec_50|10",
  [210] = "_es_50|3",
  [211] = "_es_50|10",
  [221] = "_epx_50|3",
  [222] = "_epx_50|10",
}

local function configUseReward(itemId)
  local rid = realIdOf(itemId)
  if rid and REALITEM_USE_REWARD[tonumber(rid)] then
    return REALITEM_USE_REWARD[tonumber(rid)]
  end
  local rows = _ENV.ConfigMgr:GetConfig("realitem")
  if not rid or type(rows) ~= "table" then return nil end
  local row = rows[rid] or rows[tostring(rid)]
  return type(row) == "table" and row.UseReward or nil
end

local function grantRewards(entries, sync)
  local items = _ENV.ConfigMgr:GetConfig("item") or {}
  local shown = {}
  for _, e in ipairs(entries) do
    local id, n = e.id, math.floor(e.count or 1)
    local cfg = items[id]
    if id == "gift_equip" then
      local tid = equipTemplateId(e.args)
      if tid then
        sync.EQUIP = sync.EQUIP or moduleState("EQUIP")
        local eq = sync.EQUIP
        eq.el = type(eq.el) == "table" and eq.el or {}
        for _ = 1, n do
          local euid = math.floor(tonumber(eq.euid) or 1)
          eq.el[tostring(euid)] = { [1] = (tid << 16) | (1 << 8) | 1 | EQUIP_NEW_MASK,
            [2] = 1, [3] = {}, [5] = 0 }
          eq.euid = euid + 1
        end
        shown[#shown + 1] = { id = tostring(e.args), count = n }
      else
        print("[OFFLINE] reward UNRESOLVED equipment " .. tostring(e.args))
      end
    elseif type(cfg) == "table" and cfg.type == "Economic" then
      sync.ECO = sync.ECO or moduleState("ECO")
      local eco = sync.ECO
      eco.d = type(eco.d) == "table" and eco.d or {}
      eco.d[id] = (tonumber(eco.d[id]) or 0) + n
      shown[#shown + 1] = { id = id, count = n }
    else
      local rid = realIdOf(id)
      if rid then
        sync.ECO = sync.ECO or moduleState("ECO")
        local eco = sync.ECO
        local t = {}
        for _, x in ipairs(type(eco.t) == "table" and eco.t or {}) do
          if type(x) == "table" and (tonumber(x[1]) or 0) ~= 0 then t[#t + 1] = x end
        end
        for _ = 1, n do t[#t + 1] = { [1] = (rid << 7) | 1, [2] = os.time() } end
        eco.t = t
        shown[#shown + 1] = { id = id, count = n }
      else
        print("[OFFLINE] reward UNRESOLVED item " .. tostring(id) .. " x" .. tostring(n))
      end
    end
  end
  return shown
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

  -- custom_data_module.lua:59-64 sends data = {{key=, value=}, ...}; the
  -- client keeps CUSTOM.d as key -> value (equip plans live here) and lut.
  ["BASE.CUSTOM_UPDATE"] = function(data)
    data = type(data) == "table" and data or {}
    local st = NetAgent.state or initState()
    local c = type(st.CUSTOM) == "table" and st.CUSTOM or {}
    c.d = type(c.d) == "table" and c.d or {}
    for _, kv in ipairs(type(data.data) == "table" and data.data or {}) do
      if type(kv) == "table" and kv.key ~= nil then c.d[kv.key] = kv.value end
    end
    c.lut = os.time()
    st.CUSTOM = c
    saveState()
    return { ret_code = protoCode("SUCCESS", 1) }
  end,

  -- aim_module.lua:161-170: AIM.CLAIM_REWARD {index}; callback needs
  -- ret_code and reward. ca = current aim, cav = its progress, cr/er are
  -- 32-bit claimed-record words read by getRecord (lua:149-159).
  ["AIM.CLAIM_REWARD"] = function(data)
    data = type(data) == "table" and data or {}
    local index = math.floor(tonumber(data.index) or 0)
    local cfg = index > 0 and _ENV.ConfigMgr:GetAimConfig(index)
    if type(cfg) ~= "table" then
      print("[OFFLINE] AIM.CLAIM_REWARD unknown index " .. tostring(data.index))
      return { ret_code = protoCode("FAIL", 0) }
    end
    local sync = {}
    local aim = moduleState("AIM")
    aim.cr = type(aim.cr) == "table" and aim.cr or {}
    local w = math.ceil(index / 32)
    for i = 1, w do aim.cr[i] = aim.cr[i] or 0 end
    aim.cr[w] = aim.cr[w] | (1 << ((index - 1) % 32))
    if (tonumber(aim.ca) or 1) == index then
      aim.ca = index + 1
      aim.cav = 0
    end
    sync.AIM = aim
    local reward = grantRewards(rewardEntries(cfg.reward), sync)
    print("[OFFLINE] AIM claim " .. index .. " reward=" .. ser(reward))
    return { ret_code = protoCode("SUCCESS", 1), reward = reward }, sync
  end,

  -- economic_module.lua:300-313: ITEM.USE {item_id, item_index, use_count};
  -- the item's realitem UseReward is granted.
  ["ITEM.USE"] = function(data)
    data = type(data) == "table" and data or {}
    local rid = realIdOf(data.item_id)
    local rcfg = rid and _ENV.ConfigMgr:GetRealItemConfig(rid)
    if type(rcfg) ~= "table" then
      print("[OFFLINE] ITEM.USE unknown item " .. tostring(data.item_id))
      return { ret_code = protoCode("FAIL", 0) }
    end
    local sync = { ECO = moduleState("ECO") }
    local eco = sync.ECO
    local t, removed = {}, 0
    local want = math.max(1, math.floor(tonumber(data.use_count) or 1))
    -- realitem UseCondition "WaitTime:N": the box opens N seconds after it
    -- was obtained (ECO.t entry [2] is the obtain time).
    local wait = tonumber(tostring(rcfg.UseCondition or ""):match("WaitTime:(%d+)")) or 0
    local now = os.time()
    for _, x in ipairs(type(eco.t) == "table" and eco.t or {}) do
      local v = type(x) == "table" and (tonumber(x[1]) or 0) or 0
      if v ~= 0 then
        local ready = now - (tonumber(x[2]) or now) >= wait
        if removed < want and ready and ((v >> 7) & 511) == rid then
          removed = removed + 1
        else
          t[#t + 1] = x
        end
      end
    end
    if removed == 0 then
      print("[OFFLINE] ITEM.USE not owned or not ready " .. tostring(data.item_id))
      return { ret_code = protoCode("FAIL", 0) }
    end
    eco.t = t
    local entries = {}
    for _ = 1, removed do
      for _, e in ipairs(rewardEntries(rcfg.UseReward)) do entries[#entries + 1] = e end
    end
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] ITEM.USE " .. tostring(data.item_id) .. " x" .. removed .. " reward=" .. ser(reward))
    return { ret_code = protoCode("SUCCESS", 1), reward = reward }, sync
  end,

  -- BATTLE module state. A sync replaces the module's data, so every BATTLE
  -- sync carries the whole state, seeded from the module's own defaults in
  -- ModuleDef.SYNC. Utils.Key2Index only maps top-level keys, so state lives
  -- under the module's own keys. battle_module.lua:213-236,274-276 reads
  -- data "vi" (server battle info) and its "ctl" = {[tco key] = count
  -- already reported}; the client reports new picks as
  -- choose_tco = {{key=, value=}, ...} on ENTER_ROOM and OVER.
  ["BATTLE.START"] = function(data)
    data = type(data) == "table" and data or {}
    local stage = tostring(data.stage_id or "")
    local st = moduleDefaults("BATTLE")
    st.vi = { ctl = {} }
    st.stage = stage
    st.rid = _ENV.ConfigMgr:GetRoomId(stage, 1) or ""
    st.room = 1
    st.time = 0
    NetAgent.battle = st
    pcall(function()
    end)
    return { ret_code = protoCode("SUCCESS", 1) }, { BATTLE = st }
  end,
  -- BATTLE.ENTER_ROOM (battle_module.lua:238-272) sends stage_id, the
  -- 1-based room_index it is entering, the elapsed time and choose_tco; it
  -- only sends when room_index > BATTLE.room and its callback reads "rid".
  ["BATTLE.ENTER_ROOM"] = function(data)
    data = type(data) == "table" and data or {}
    local st = NetAgent.battle or moduleDefaults("BATTLE")
    st.vi = type(st.vi) == "table" and st.vi or {}
    st.vi.ctl = type(st.vi.ctl) == "table" and st.vi.ctl or {}
    st.stage = tostring(data.stage_id or st.stage or "")
    st.room = math.floor(tonumber(data.room_index) or ((st.room or 0) + 1))
    st.rid = _ENV.ConfigMgr:GetRoomId(st.stage, st.room) or ""
    st.time = math.floor(tonumber(data.time) or st.time or 0)
    addChosenTco(st, data.choose_tco)
    NetAgent.battle = st
    return { ret_code = protoCode("SUCCESS", 1) }, { BATTLE = st }
  end,
  -- BATTLE.CHOOSE_TCO (battle_module_tco.lua:636-675) sends {id = tco
  -- server_id}; the callback only checks ret_code == SUCCESS and reads an
  -- optional count (defaults to 1).
  -- BATTLE.DEAD is sent by native code with no args when the hero dies;
  -- battle_module.GetDeadTime (lua:188-195) reads the death count as
  -- vi.dt, so the response counts the death in the BATTLE state.
  ["BATTLE.DEAD"] = function()
    local st = NetAgent.battle or moduleDefaults("BATTLE")
    st.vi = type(st.vi) == "table" and st.vi or {}
    st.vi.ctl = type(st.vi.ctl) == "table" and st.vi.ctl or {}
    st.vi.dt = (tonumber(st.vi.dt) or 0) + 1
    NetAgent.battle = st
    return { ret_code = protoCode("SUCCESS", 1) }, { BATTLE = st }
  end,
  -- BATTLE.OVER (battle_module.lua:448-494) sends stage_id, stage_level,
  -- result (BATTLE_RESULT name), time, coin and kill/choose_tco; its
  -- callback ignores the response and fires BATTLE.STAGE_OVER, but a
  -- non-SUCCESS ret_code raises "Server error". proto_def lists
  -- extra_reward and star_reward (*starreward) in the response; nothing
  -- extra is awarded offline. The battle ends: BATTLE returns to defaults.
  -- On a win the coins picked up are credited and a main stage advances
  -- ADV "stage" (economic_module.passStage: passed N <=> stage > N).
  ["BATTLE.OVER"] = function(data)
    data = type(data) == "table" and data or {}
    local sync = { BATTLE = moduleDefaults("BATTLE") }
    NetAgent.battle = nil
    local names = _ENV.BattleModule and _ENV.BattleModule.BATTLE_RESULT
    local result = data.result
    local won = result == 1 or result == "VICTORY" or (type(names) == "table" and names[result] == "VICTORY")
        print("[OFFLINE] OVER stage=" .. tostring(data.stage_id) .. " result=" .. tostring(result) .. " won=" .. tostring(won) .. " coin=" .. tostring(data.coin))
    if won then
      local eco = moduleState("ECO")
      eco.d = type(eco.d) == "table" and eco.d or {}
      local coinId = _ENV.GameDef.ITEM_ID and _ENV.GameDef.ITEM_ID.COIN or "coin"
      eco.d[coinId] = (tonumber(eco.d[coinId]) or 0) + math.floor(tonumber(data.coin) or 0)
      sync.ECO = eco
      local cfg = _ENV.ConfigMgr:GetStageConfig(tostring(data.stage_id or ""))
      if type(cfg) == "table" and tonumber(cfg.index) then
        local adv = moduleState("ADV")
        local nextIndex = math.floor(tonumber(cfg.index)) + 1
        if cfg.type == "main" and (tonumber(adv.stage) or 1) < nextIndex then
          adv.stage = nextIndex
          adv.room = -1
          sync.ADV = adv
          if nextIndex == 2 then
            -- First clear of the tutorial stage. The guide that runs next
            -- (guide_battle_over -> guide_equip_0, "A Weapon and a ULT Disk
            -- ... Try them on!") equips both slots and needs both items
            -- owned. They are the gift_equip entries of the rookie box
            -- box1_1's realitem UseReward; that config row is read here.
            local box = {}
            for _, e in ipairs(rewardEntries(configUseReward("box1_1"))) do
              if e.id == "gift_equip" then box[#box + 1] = e end
            end
            if #box == 0 then print("[OFFLINE] UNRESOLVED box1_1 UseReward") end
            local got = grantRewards(box, sync)
            print("[OFFLINE] tutorial gear " .. ser(got))
          end
        end
      end
    end
    return { ret_code = protoCode("SUCCESS", 1), extra_reward = {}, star_reward = {} }, sync
  end,
  -- GUIDE "gf" is a bit set: guide_module.GetFlag (lua:14-21) tests
  -- gf & (1 << (ConfigMgr:GetFlagIndex(step) - 1)). STEP_FINISH sends
  -- {step}; SET_GUIDE_STEP_LIST sends {step_list}. Their callbacks only
  -- read ret_code and an optional reward, and no reward is granted offline.
  ["GUIDE.STEP_FINISH"] = function(data)
    data = type(data) == "table" and data or {}
    return { ret_code = protoCode("SUCCESS", 1) }, { GUIDE = setGuideFlags({ data.step }) }
  end,
  ["GUIDE.SET_GUIDE_STEP_LIST"] = function(data)
    data = type(data) == "table" and data or {}
    return { ret_code = protoCode("SUCCESS", 1) }, { GUIDE = setGuideFlags(data.step_list) }
  end,
  ["BATTLE.CHOOSE_TCO"] = function(data)
    return { ret_code = protoCode("SUCCESS", 1), count = 1 }
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


function NetAgent:Login(...)
  local gd = _ENV.GameDef
  local success = 1
  if type(gd) == "table" then
    if type(gd.LOGIN_RESULT) == "table" and gd.LOGIN_RESULT.SUCCESS ~= nil then
      success = gd.LOGIN_RESULT.SUCCESS
    end
  end

  -- role_data: the client's own new-player defaults from ModuleDef.SYNC,
  -- serialized as a plain data literal (str2lua loads it in a sandbox, so it
  -- must not call functions).
  local U = _ENV.Utils
  local profile = {}
  local state = initState()
  local md = _ENV.ModuleDef
  if type(md) == "table" and type(md.SYNC) == "table" then
    for i, m in ipairs(md.SYNC) do
      local data = state[m.name] or m.data or {}
      local ix, order = encode(wire(m.name, data))
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
  local role = ""
  local ok, packed = pcall(function()
    if _ENV.Compressor and _ENV.Compressor.Compress then
      return _ENV.Compressor:Compress(literal)
    end
    return literal
  end)
  if ok and type(packed) == "string" then role = packed end

  self.logined = true
  return {
    login_result    = success,
    role_data       = role,
    server_timezone = 0,
    server_time     = os.time(),
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
