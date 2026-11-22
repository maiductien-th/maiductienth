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
  local tmp = SAVE_PATH .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then print("[OFFLINE] save: cannot open " .. tmp); return end
  local wrote, werr = f:write("return " .. ser(NetAgent.state))
  local flushed, ferr = f:flush()
  local closed, cerr = f:close()
  if not (wrote and flushed and closed) then
    os.remove(tmp)
    print("[OFFLINE] save failed, kept previous profile: " ..
      tostring(werr or ferr or cerr))
    return
  end
  -- rename(2) replaces the old profile atomically, so it is never deleted first.
  local ok, rerr = os.rename(tmp, SAVE_PATH)
  print("[OFFLINE] saved profile ok=" .. tostring(ok) ..
    (ok and "" or " " .. tostring(rerr)))
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
  -- No ad network offline: VIP/GM flag NO_AD (GameDef 8) makes
  -- VipModule.IsNoADForCS tell AdRewardMgr to grant ad rewards directly.
  for _, m in ipairs({ "VIP", "GM" }) do
    if type(st[m]) == "table" then st[m].f = (tonumber(st[m].f) or 0) | 8 end
  end
  -- Offline nothing announces a new day, so roll the daily state over here,
  -- before the login profile is built (as PLAYER.DAILY_RESET does).
  local okDay, day = pcall(function() return _ENV.GetDateNumber() end)
  day = okDay and tonumber(day) or tonumber(os.date("%Y%m%d"))
  local lastDay = saved and tonumber(saved._day)
  if lastDay and lastDay < day then
    if type(st.PLAYER) == "table" then st.PLAYER.dg = 0 end
    if type(st.SHOP) == "table" then st.SHOP.tph = {}; st.SHOP.tsl = {} end
    if type(st.BOX) == "table" then st.BOX.ot = {} end
    print("[OFFLINE] new day " .. tostring(lastDay) .. " -> " .. tostring(day))
  end
  st._day = day
  if NetAgent.ensureShops and type(st.SHOP) == "table" then NetAgent.ensureShops(st.SHOP) end
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

-- remote_module_base.updateModuleData merges a sync into the client's data:
-- {["_"] = t} replaces a table, "*" removes a key, anything else is merged.
-- Replacing a whole map such as EQUIP.el makes every entry look new to the
-- ".el" change handler (old value nil), which fires EQUIP.New per item and
-- duplicates the bag list. Send only the entries that changed against what
-- the client already holds, replacing each changed entry as a unit.
local function syncDelta(ix, prevIx)
  local out = {}
  for k, v in pairs(ix) do
    local old = type(prevIx) == "table" and prevIx[k] or nil
    if type(v) ~= "table" then
      out[k] = v
    elseif type(old) ~= "table" then
      out[k] = { ["_"] = v }
    else
      local d, changed = {}, false
      for sk, nv in pairs(v) do
        if not same(old[sk], nv) then
          d[sk] = type(nv) == "table" and { ["_"] = nv } or nv
          changed = true
        end
      end
      for sk in pairs(old) do
        if v[sk] == nil then d[sk] = "*"; changed = true end
      end
      if changed then out[k] = d end
    end
  end
  if type(prevIx) == "table" then
    for k in pairs(prevIx) do
      if ix[k] == nil then out[k] = "*" end
    end
  end
  return out
end

local function fireSync(agent, partials)
  if type(partials) ~= "table" then return end
  local md, mgr = _ENV.ModuleDef, _ENV.RemoteModuleMgr
  local out, n = {}, 0
  for i, m in ipairs(md.SYNC) do
    local part = partials[m.name]
    if part ~= nil then
      local prev = NetAgent.state and NetAgent.state[m.name]
      if NetAgent.state then NetAgent.state[m.name] = deepcopy(part) end
      local mod = mgr and mgr:GetModuleByIndex(i)
      local en = mod and mod.key_enum
      local ix = encode(part, en)
      local prevIx = type(prev) == "table" and encode(prev, en) or nil
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
        if m.name ~= "ECO" then ix = syncDelta(ix, prevIx) end
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
-- link=5) and base_value = template_id << 16 | stars << 8 | level | NEW_MASK
-- (equip_module ParseEquipBaseValue).
-- equip_module.lua:17-18 define both flags. On device, bit 31 renders the
-- "New!" badge and bit 30 the lock (it also blocks decompose), so that is
-- the mapping used here.
local EQUIP_NEW_MASK = 2147483648
local EQUIP_LOCK_MASK = 1073741824

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

-- True when grantRewards knows how to grant every entry; callers that
-- charge for a reward check this first so nothing is paid for nothing.
local function rewardsGrantable(entries)
  local items = _ENV.ConfigMgr:GetConfig("item") or {}
  for _, e in ipairs(entries) do
    local cfg = items[e.id]
    local kind = type(cfg) == "table" and cfg.type
    if e.id == "gift_equip" then
      if not equipTemplateId(e.args) then return false, e.args end
    elseif kind ~= "Economic" and kind ~= "Energy" and kind ~= "Capacity"
        and kind ~= "PetCapacity"
        and not realIdOf(e.id) then
      return false, e.id
    end
  end
  return true
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
    elseif type(cfg) == "table" and cfg.type == "Energy" then
      -- energy_module.GetEnergy reads ENERGY.e.
      sync.ENERGY = sync.ENERGY or moduleState("ENERGY")
      sync.ENERGY.e = (tonumber(sync.ENERGY.e) or 0) + n
      shown[#shown + 1] = { id = id, count = n }
    elseif type(cfg) == "table" and cfg.type == "Capacity" then
      -- equip_module.GetExtraCapacity reads EQUIP.ac.
      sync.EQUIP = sync.EQUIP or moduleState("EQUIP")
      sync.EQUIP.ac = (tonumber(sync.EQUIP.ac) or 0) + n
      shown[#shown + 1] = { id = id, count = n }
    elseif type(cfg) == "table" and cfg.type == "PetCapacity" then
      -- pet_module.GetPetExtraCapacity reads PET.ac.
      sync.PET = sync.PET or moduleState("PET")
      sync.PET.ac = (tonumber(sync.PET.ac) or 0) + n
      shown[#shown + 1] = { id = id, count = n }
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
-- Offline economy helpers shared by the shop, equipment, technology,
-- sign-in and battle-reward handlers below.
local function okRes(t)
  t = t or {}
  t.ret_code = protoCode("SUCCESS", 1)
  return t
end
local function failRes(msg)
  print("[OFFLINE] " .. msg)
  return { ret_code = protoCode("FAIL", 0) }
end
local function tbl(v) return type(v) == "table" and v or {} end
-- Config tables are arrays or string-keyed "1","2",...; return the values in key order.
local function seq(t)
  if type(t) ~= "table" then return {} end
  if t.id ~= nil then return { t } end
  local keys = {}
  for k in pairs(t) do if tonumber(k) then keys[#keys + 1] = k end end
  table.sort(keys, function(a, b) return tonumber(a) < tonumber(b) end)
  local out = {}
  for _, k in ipairs(keys) do out[#out + 1] = t[k] end
  return out
end
local function cfgAt(t, k)
  if type(t) ~= "table" then return nil end
  local v = t[k]
  if v == nil then v = t[tostring(k)] end
  if v == nil and tonumber(k) then v = t[math.floor(tonumber(k))] end
  return v
end

-- How many of an item the player owns: Economic items are counters in
-- ECO.d, other realitems are one ECO.t entry each ((rid << 7) | 1).
local function owned(sync, id)
  sync.ECO = sync.ECO or moduleState("ECO")
  local eco = sync.ECO
  eco.d = tbl(eco.d)
  local items = _ENV.ConfigMgr:GetConfig("item") or {}
  local cfg = items[id]
  if type(cfg) == "table" and cfg.type == "Economic" then
    return tonumber(eco.d[id]) or 0, "d"
  end
  local rid = realIdOf(id)
  if not rid then return 0 end
  local n = 0
  for _, x in ipairs(tbl(eco.t)) do
    local v = type(x) == "table" and (tonumber(x[1]) or 0) or 0
    if v ~= 0 and ((v >> 7) & 511) == rid then n = n + 1 end
  end
  return n, "t", rid
end

-- Deducts every {[item_id] = count} cost, or nothing if one is short.
local function spend(sync, costs)
  for id, n in pairs(costs) do
    if (owned(sync, id)) < (tonumber(n) or 0) then return false, id end
  end
  for id, n in pairs(costs) do
    n = math.floor(tonumber(n) or 0)
    if n > 0 then
      local have, kind, rid = owned(sync, id)
      local eco = sync.ECO
      if kind == "d" then
        eco.d[id] = have - n
      else
        local t, removed = {}, 0
        for _, x in ipairs(tbl(eco.t)) do
          local v = type(x) == "table" and (tonumber(x[1]) or 0) or 0
          if v ~= 0 then
            if removed < n and ((v >> 7) & 511) == rid then removed = removed + 1 else t[#t + 1] = x end
          end
        end
        eco.t = t
      end
    end
  end
  return true
end

-- remote_module_base.GetBitIndexAndOffset: per = floor(32 / bits) values per
-- 32-bit word, word = floor(index / per) + 1, shift = (index % per) * bits.
local function setBits(t, index, bits, value)
  local per = 32 // bits
  local w = index // per + 1
  local sh = (index % per) * bits
  for i = 1, w do t[i] = t[i] or 0 end
  local mask = ((1 << bits) - 1) << sh
  t[w] = (t[w] & ~mask) | ((value << sh) & mask)
end

-- No client config holds the server's shop roll; one entry per pool is
-- picked by weight, with no discount (DISCOUNT_ENUM index 1 = 100%).
local POOL_SHOPS = { "coin", "gem", "tb" }
local function noDiscountIndex()
  local de = _ENV.GameDef and _ENV.GameDef.DISCOUNT_ENUM
  if type(de) == "table" then
    for i, v in ipairs(de) do if tonumber(v) == 100 then return i end end
  end
  return 1
end
local function rollShop(shopType)
  local rows = _ENV.ConfigMgr:GetConfig("shop") or {}
  local pools, order = {}, {}
  for _, r in pairs(rows) do
    if type(r) == "table" and r.shop == shopType and (tonumber(r.bitIndex) or 0) > 0
        and (tonumber(r.hide) or 0) == 0 then
      local p = (r.pool ~= nil and r.pool ~= "") and r.pool or r.id
      if not pools[p] then pools[p] = {}; order[#order + 1] = p end
      table.insert(pools[p], r)
    end
  end
  table.sort(order)
  local slot = { id = {}, d = {}, c = 0 }
  local dn = noDiscountIndex()
  for _, p in ipairs(order) do
    local list = pools[p]
    table.sort(list, function(a, b) return tonumber(a.bitIndex) < tonumber(b.bitIndex) end)
    local total = 0
    for _, r in ipairs(list) do total = total + math.max(1, tonumber(r.weight) or 1) end
    local roll, pick = math.random() * total, list[#list]
    for _, r in ipairs(list) do
      roll = roll - math.max(1, tonumber(r.weight) or 1)
      if roll <= 0 then pick = r; break end
    end
    local bi = math.floor(tonumber(pick.bitIndex)) - 1
    setBits(slot.id, bi, 1, 1)
    setBits(slot.d, bi, 4, dn)
  end
  return slot
end
local function ensureShops(shop)
  shop.tsl = tbl(shop.tsl)
  for _, s in ipairs(POOL_SHOPS) do
    if type(shop.tsl[s]) ~= "table" then shop.tsl[s] = rollShop(s) end
  end
  return shop
end
NetAgent.ensureShops = ensureShops

-- No drop tables ship with the client (ConfigMgr "drop_group" is nil), so a
-- main-stage win drops one piece from the equipment set of its chapter.
local DROP_SETS = { 150, 200, 250, 300, 350, 400, 450 }
local function stageDrop(cfg)
  local chapter = math.max(1, math.floor(tonumber(cfg and cfg.chapter) or 1))
  local base = DROP_SETS[math.min(chapter, #DROP_SETS)]
  local rows = _ENV.ConfigMgr:GetConfig("equipment") or {}
  local pool = {}
  for _, r in pairs(rows) do
    local id = type(r) == "table" and tonumber(r.id)
    if id and id > base and id <= base + 5 and (tonumber(r.valid) or 0) == 1 then pool[#pool + 1] = r.name end
  end
  table.sort(pool)
  if #pool == 0 then return nil end
  return { id = "gift_equip", count = 1, args = pool[math.random(#pool)] }
end

-- Stage stars: one per met starConditions entry (victory, duration <= param
-- seconds, deaths < param revives). ADV.star keeps 2 bits per stage index
-- (adventure_module RECORD_BIT=2, RECORD_COUNT=16).
local function countStars(cfg, data, deaths)
  local n = 0
  for _, c in ipairs(seq(cfg.starConditions)) do
    local p = tonumber(c.param) or 0
    if c.id == "victory" then n = n + 1
    elseif c.id == "duration" then
      if (tonumber(data.time) or math.huge) <= p then n = n + 1 end
    elseif c.id == "revive" then
      if deaths < p then n = n + 1 end
    else
      print("[OFFLINE] star condition UNRESOLVED " .. tostring(c.id))
    end
  end
  return math.min(n, 3)
end
local function recordStars(words, index, stars)
  local pos = (index - 1) * 2
  local w, sh = pos // 32 + 1, pos % 32
  for i = 1, w do words[i] = words[i] or 0 end
  local old = (words[w] >> sh) & 3
  if stars > old then words[w] = (words[w] & ~(3 << sh)) | (stars << sh) end
  return old
end

-- Daily sign-in: PLAYER.tst counts signed days, lsd is the last sign date
-- (player_module CanSign compares GetDateNumber() with lsd); day = tst % 7.
local function signRow(tst)
  -- Same week/day as player_module.GetSignInfo; config_mgr.GetDailySignConfig
  -- falls back to week 4 once the table runs out.
  local t = math.max(1, tst)
  local week, day = math.ceil(t / 7), (t - 1) % 7 + 1
  local ok, row = pcall(function() return _ENV.ConfigMgr:GetDailySignConfig(week, day) end)
  return ok and row or nil
end
local function getBits(t, index, bits)
  local per = 32 // bits
  local v = tonumber(t[index // per + 1]) or 0
  return (v >> ((index % per) * bits)) & ((1 << bits) - 1)
end
-- energy_module: ENERGY.e is the count, ENERGY.tst the server time the
-- regeneration timer started (0 when full); one point per
-- GetEnergyAutoIncreaseTime() seconds up to GetMaxEnergy().
local function energyParams()
  local maxE, step = 20, 720
  pcall(function() maxE = tonumber(_ENV.EnergyModule:GetMaxEnergy()) or maxE end)
  pcall(function() step = tonumber(_ENV.EnergyModule:GetEnergyAutoIncreaseTime()) or step end)
  return maxE, math.max(1, math.floor(step))
end
local function regenEnergy(en)
  local maxE, step = energyParams()
  local e, tst, now = tonumber(en.e) or 0, tonumber(en.tst) or 0, os.time()
  if e >= maxE then en.tst = 0; return end
  if tst <= 0 then en.tst = now; return end
  local n = (now - tst) // step
  if n <= 0 then return end
  e = math.min(maxE, e + n)
  en.e = e
  en.tst = e >= maxE and 0 or tst + n * step
end
local function today()
  local ok, v = pcall(function() return _ENV.GetDateNumber() end)
  if ok and tonumber(v) then return tonumber(v) end
  return tonumber(os.date("%Y%m%d"))
end

-- TECHNOLOGY.tl stores levels by the config's save_group (technology_module
-- GetTechLevel): n[save_index], one bit in b, or a 4-bit level in b4.
local function setTechLevel(tl, cfg, level)
  local si = math.floor(tonumber(cfg.save_index) or 0)
  if si <= 0 then return false end
  if cfg.save_group == "normal" then
    tl.n = tbl(tl.n); tl.n[si] = level
  elseif cfg.save_group == "bit" then
    tl.b = tbl(tl.b); setBits(tl.b, si - 1, 1, level > 0 and 1 or 0)
  elseif cfg.save_group == "bit4" then
    tl.b4 = tbl(tl.b4); setBits(tl.b4, si - 1, 4, level & 15)
  else
    return false
  end
  return true
end
local function techCost(id, kind)
  local ok, v = pcall(function() return _ENV.TechnologyModule:GetResearchCost(id, kind) end)
  return ok and tonumber(v) or nil
end

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
    -- box1_1's gift_equip entries are the tutorial gear, already granted on
    -- the first clear of sm_1 (BATTLE.OVER) so the equip guide can run.
    local skipGear = rid == realIdOf("box1_1")
    local entries = {}
    for _ = 1, removed do
      for _, e in ipairs(rewardEntries(configUseReward(data.item_id) or rcfg.UseReward)) do
        if not (skipGear and e.id == "gift_equip") then entries[#entries + 1] = e end
      end
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
  -- hero_module.lua LevelUp: client checks ECO via GetLevelupCost
  -- (ConfigMgr:GetHeroLevelupCost -> cost_coin, cost_material of
  -- ITEM_ID.COIN / ITEM_ID.HERO_LEVELUP_MATERIAL), then sends {id, level}
  -- and only reads ret_code.
  ["HERO.LEVELUP"] = function(data)
    data = type(data) == "table" and data or {}
    local id, level = tostring(data.id or ""), math.floor(tonumber(data.level) or 0)
    local hero = moduleState("HERO")
    hero.hl = type(hero.hl) == "table" and hero.hl or {}
    local cur = type(hero.hl[id]) == "table" and (tonumber(hero.hl[id].l) or 1) or nil
    local ok, coin, mat = pcall(function() return _ENV.ConfigMgr:GetHeroLevelupCost(id, level) end)
    coin, mat = tonumber(coin), tonumber(mat)
    local ids = _ENV.GameDef.ITEM_ID or {}
    local eco = moduleState("ECO")
    eco.d = type(eco.d) == "table" and eco.d or {}
    local cid, mid = ids.COIN or "coin", ids.HERO_LEVELUP_MATERIAL
    if not cur or level ~= cur + 1 or not ok or not coin or not mat or not mid
        or (tonumber(eco.d[cid]) or 0) < coin or (tonumber(eco.d[mid]) or 0) < mat then
      print("[OFFLINE] HERO.LEVELUP rejected id=" .. id .. " level=" .. level)
      return { ret_code = protoCode("FAIL", 0) }
    end
    eco.d[cid] = eco.d[cid] - coin
    eco.d[mid] = eco.d[mid] - mat
    hero.hl[id].l = level
    print("[OFFLINE] HERO.LEVELUP " .. id .. " -> " .. level .. " coin-" .. coin .. " " .. tostring(mid) .. "-" .. mat)
    return { ret_code = protoCode("SUCCESS", 1) }, { HERO = hero, ECO = eco }
  end,

  ["BATTLE.START"] = function(data)
    data = type(data) == "table" and data or {}
    local stage = tostring(data.stage_id or "")
    local st = moduleDefaults("BATTLE")
    st.vi = { ctl = {} }
    st.stage = stage
    st.rid = _ENV.ConfigMgr:GetRoomId(stage, 1) or ""
    st.room = 1
    st.time = 0
    local sync = { BATTLE = st }
    local scfg = _ENV.ConfigMgr:GetStageConfig(stage)
    for _, c in ipairs(rewardEntries(seq(type(scfg) == "table" and scfg.cost))) do
      if c.id == "energy" then
        local en = moduleState("ENERGY")
        regenEnergy(en)
        local e = tonumber(en.e) or 0
        if e < c.count then return failRes("BATTLE.START " .. stage .. " needs energy " .. c.count) end
        en.e = e - c.count
        local maxE = energyParams()
        if en.e < maxE and (tonumber(en.tst) or 0) <= 0 then en.tst = os.time() end
        sync.ENERGY = en
        print("[OFFLINE] BATTLE.START " .. stage .. " energy " .. e .. " -> " .. en.e)
      end
    end
    NetAgent.battle = st
    return { ret_code = protoCode("SUCCESS", 1) }, sync
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
    local deaths = tonumber(NetAgent.battle and NetAgent.battle.vi and NetAgent.battle.vi.dt) or 0
    NetAgent.battle = nil
    local stars, starReward, reward = 0, {}, {}
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
        -- Stars: ADV.star for normal difficulty; star rewards (rewardStarN)
        -- are granted once, when that star is first earned.
        if cfg.type == "main" and (tonumber(data.stage_level) or 1) <= 1 then
          local adv = sync.ADV or moduleState("ADV")
          adv.star = tbl(adv.star)
          stars = countStars(cfg, data, deaths)
          local old = recordStars(adv.star, math.floor(tonumber(cfg.index)), stars)
          sync.ADV = adv
          for n = old + 1, stars do
            local got = grantRewards(rewardEntries(cfg["rewardStar" .. n]), sync)
            starReward[#starReward + 1] = { star = n, reward = got }
          end
          local drop = stageDrop(cfg)
          if drop then reward = grantRewards({ drop }, sync) end
          print("[OFFLINE] OVER stars=" .. stars .. " (had " .. old .. ") deaths=" .. deaths
            .. " starReward=" .. ser(starReward) .. " drop=" .. ser(reward))
        end
      end
    end
    return { ret_code = protoCode("SUCCESS", 1), stars = stars, reward = reward,
      extra_reward = {}, star_reward = starReward }, sync
  end,
  -- GUIDE "gf" is a bit set: guide_module.GetFlag (lua:14-21) tests
  -- gf & (1 << (ConfigMgr:GetFlagIndex(step) - 1)). STEP_FINISH sends
  -- {step}; SET_GUIDE_STEP_LIST sends {step_list}. Their callbacks only
  -- read ret_code and an optional reward, and no reward is granted offline.
  -- shop_module.RequestPurchase (lua:83-120) checks tph[id] against the
  -- shop config's dailyLimit and the (discounted) price, then sends
  -- {id, ad_sig, count}; the callback fires SHOP.PURCHASE.<id> with
  -- ret_code and reward. Video-priced items are granted without an ad.
  ["SHOP.PURCHASE"] = function(data)
    data = tbl(data)
    local id = tostring(data.id or "")
    local count = math.max(1, math.floor(tonumber(data.count) or 1))
    local cfg = _ENV.ConfigMgr:GetShopItemConfig(id)
    if type(cfg) ~= "table" then return failRes("SHOP.PURCHASE unknown item " .. id) end
    local shop = ensureShops(moduleState("SHOP"))
    shop.tph = tbl(shop.tph)
    local limit = tonumber(cfg.dailyLimit) or 0
    if limit > 0 and (tonumber(shop.tph[id]) or 0) + count > limit then
      return failRes("SHOP.PURCHASE daily limit " .. id)
    end
    local entries = {}
    for _ = 1, count do
      for _, e in ipairs(rewardEntries(seq(cfg.reward))) do entries[#entries + 1] = e end
    end
    local grantable, missing = rewardsGrantable(entries)
    if not grantable then
      return failRes("SHOP.PURCHASE " .. id .. " reward not supported offline: " .. tostring(missing))
    end
    local sync = { SHOP = shop }
    local price = tbl(cfg.price)
    local pid = tostring(price.id or "")
    if pid == "rmb" then
      return failRes("SHOP.PURCHASE " .. id .. " is a real-money item; no billing offline")
    end
    if pid ~= "video" and pid ~= "" then
      local disc = 100
      pcall(function()
        local v = _ENV.ShopModule:GetDiscount(cfg.shop, cfg.bitIndex)
        if tonumber(v) then disc = tonumber(v) end
      end)
      local cost = math.floor((tonumber(price.count) or 0) * count * disc / 100)
      local paid, short = spend(sync, { [pid] = cost })
      if not paid then return failRes("SHOP.PURCHASE " .. id .. " short of " .. tostring(short)) end
    end
    shop.tph[id] = (tonumber(shop.tph[id]) or 0) + count
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] SHOP.PURCHASE " .. id .. " x" .. count .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  -- energy_module.CheckIncrease asks once the next point is due.
  ["ENERGY.INCREASE"] = function()
    local en = moduleState("ENERGY")
    regenEnergy(en)
    return okRes(), { ENERGY = en }
  end,
  -- purchase_module.ECO_PURCHASE sends {sku_id, ad_sig} for the free and
  -- "video" packs. Limits live in PURCHASE.lpc[period] = {i = period
  -- number from the global daily()/weekly()/monthly(), c = 4-bit counters
  -- at conditionLimit's index}; pcr[sku] counts purchases.
  ["PURCHASE.ECO_PURCHASE"] = function(data)
    data = tbl(data)
    local sku = tostring(data.sku_id or "")
    local cfg = _ENV.ConfigMgr:GetSKUConfig(sku)
    if type(cfg) ~= "table" then return failRes("PURCHASE.ECO_PURCHASE unknown sku " .. sku) end
    if cfg.model ~= "video" and cfg.model ~= "free" then
      return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " model " .. tostring(cfg.model) .. " needs real billing")
    end
    local entries = rewardEntries(seq(cfg.itemList))
    local grantable, missing = rewardsGrantable(entries)
    if not grantable then
      return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " reward not supported offline: " .. tostring(missing))
    end
    local pur = moduleState("Purchase")
    local cl = cfg.conditionLimit
    if type(cl) == "table" then
      local period, index, limit = cfgAt(cl, 1), tonumber(cfgAt(cl, 2)), tonumber(cfgAt(cl, 3))
      local fn = type(period) == "string" and _ENV[period]
      if type(fn) ~= "function" or not index or not limit then
        return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " bad conditionLimit " .. ser(cl))
      end
      local pnum = fn()
      pur.lpc = tbl(pur.lpc)
      local rec = tbl(pur.lpc[period])
      if rec.i ~= pnum then rec = { i = pnum, c = {} } end
      rec.c = tbl(rec.c)
      local used = getBits(rec.c, index, 4)
      if used >= limit then return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " limit reached") end
      setBits(rec.c, index, 4, used + 1)
      pur.lpc[period] = rec
    end
    pur.pcr = tbl(pur.pcr)
    pur.pcr[sku] = (tonumber(pur.pcr[sku]) or 0) + 1
    local sync = { Purchase = pur }
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] PURCHASE.ECO_PURCHASE " .. sku .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  -- shop_module.RefreshShop sends {type, ad_sig}; tsl[type].c counts refreshes.
  ["SHOP.REFRESH_SHOP"] = function(data)
    data = tbl(data)
    local t = tostring(data.type or "")
    local shop = ensureShops(moduleState("SHOP"))
    local c = type(shop.tsl[t]) == "table" and (tonumber(shop.tsl[t].c) or 0) or 0
    shop.tsl[t] = rollShop(t)
    shop.tsl[t].c = c + 1
    return okRes(), { SHOP = shop }
  end,
  -- box_module.RequestOpenBox (lua:83-115): arbitrary boxes send count (one
  -- price per draw); fixed boxes send no count, cost one price and draw
  -- loopCount times. CD > 0 starts BOX.cd[box] (GetBoxCDReadyTime), and
  -- box_limit_<box> caps BOX.ot[box] per day (GetBoxDailyLimitLeftTimes).
  ["SHOP.OPEN_BOX"] = function(data)
    data = tbl(data)
    local boxId = tostring(data.box_id or "")
    local cfg = _ENV.ConfigMgr:GetBoxConfig(boxId)
    if type(cfg) ~= "table" then return failRes("SHOP.OPEN_BOX unknown box " .. boxId) end
    local paidCount = math.max(1, math.floor(tonumber(data.count) or 1))
    local count = math.max(1, math.floor(tonumber(data.count) or tonumber(cfg.loopCount) or 1))
    local now = os.time()
    local box = moduleState("BOX")
    box.cd, box.ot = tbl(box.cd), tbl(box.ot)
    if (tonumber(box.cd[boxId]) or 0) > now then return failRes("SHOP.OPEN_BOX " .. boxId .. " on cooldown") end
    local price = tbl(cfg.price)
    local limit = tonumber(_ENV.ConfigMgr["box_limit_" .. boxId]) or 999
    if (tonumber(box.ot[boxId]) or 0) >= limit then return failRes("SHOP.OPEN_BOX " .. boxId .. " daily limit") end
    local sync = { BOX = box }
    -- Only video-priced boxes are free; the UI passes an ad_sig argument
    -- for paid boxes too, so it does not waive the price.
    if price.id ~= nil and price.id ~= "video" then
      local paid, short = spend(sync, { [tostring(price.id)] = (tonumber(price.count) or 0) * paidCount })
      if not paid then return failRes("SHOP.OPEN_BOX " .. boxId .. " short of " .. tostring(short)) end
    end
    if (tonumber(cfg.CD) or 0) > 0 then box.cd[boxId] = now + math.floor(tonumber(cfg.CD)) end
    box.ot[boxId] = (tonumber(box.ot[boxId]) or 0) + 1
    local adv = moduleState("ADV")
    local entries = {}
    for _ = 1, count do
      local e = stageDrop({ chapter = math.max(1, math.ceil(((tonumber(adv.stage) or 1) - 1) / 5)) })
      if e then entries[#entries + 1] = e end
    end
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] OPEN_BOX " .. boxId .. " x" .. count .. " reward=" .. ser(reward))
    return okRes({ reward = reward, result = 0 }), sync
  end,

  -- equip_module.RequestEnhance / RequestAscend send {id = equipment uid,
  -- target}; the cost is the client's own GetEnhanceCost / GetAscendCost
  -- ({[item_id] = count}). Level is base & 255, stars (base >> 8) & 255.
  ["EQUIP.ENHANCE"] = function(data)
    data = tbl(data)
    local uid = tostring(math.floor(tonumber(data.id) or 0))
    local target = tonumber(data.target)
    local eq = moduleState("EQUIP")
    eq.el = tbl(eq.el)
    local e = eq.el[uid]
    if type(e) ~= "table" then return failRes("EQUIP.ENHANCE no equipment " .. uid) end
    local base = math.floor(tonumber(e[1]) or 0)
    -- equip_module.GetEnhanceCost: a nil target means the next level.
    target = target and math.floor(target) or (base & 255) + 1
    if target <= (base & 255) or target > 255 then return failRes("EQUIP.ENHANCE bad target " .. target) end
    local ok, flag, costs = pcall(function() return _ENV.EquipModule:GetEnhanceCost(uid, target) end)
    if not ok or flag ~= 1 or type(costs) ~= "table" then
      return failRes("EQUIP.ENHANCE cost unavailable " .. tostring(costs or flag))
    end
    local sync = { EQUIP = eq }
    local paid, short = spend(sync, costs)
    if not paid then return failRes("EQUIP.ENHANCE short of " .. tostring(short)) end
    e[1] = (base & ~255) | target
    print("[OFFLINE] EQUIP.ENHANCE " .. uid .. " -> " .. target .. " cost=" .. ser(costs))
    return okRes(), sync
  end,
  ["EQUIP.ASCEND"] = function(data)
    data = tbl(data)
    local uid = tostring(math.floor(tonumber(data.id) or 0))
    local eq = moduleState("EQUIP")
    eq.el = tbl(eq.el)
    local e = eq.el[uid]
    if type(e) ~= "table" then return failRes("EQUIP.ASCEND no equipment " .. uid) end
    local base = math.floor(tonumber(e[1]) or 0)
    local ok, flag, costs = pcall(function() return _ENV.EquipModule:GetAscendCost(uid) end)
    if not ok or flag ~= 1 or type(costs) ~= "table" then
      return failRes("EQUIP.ASCEND cost unavailable " .. tostring(costs or flag))
    end
    local sync = { EQUIP = eq }
    local paid, short = spend(sync, costs)
    if not paid then return failRes("EQUIP.ASCEND short of " .. tostring(short)) end
    local star = ((base >> 8) & 255) + 1
    e[1] = (base & ~(255 << 8)) | (star << 8)
    print("[OFFLINE] EQUIP.ASCEND " .. uid .. " -> star " .. star .. " cost=" .. ser(costs))
    return okRes(), sync
  end,
  ["EQUIP.SET_NEW"] = function(data)
    data = tbl(data)
    local eq = moduleState("EQUIP")
    eq.el = tbl(eq.el)
    local e = eq.el[tostring(math.floor(tonumber(data.id) or 0))]
    if type(e) ~= "table" then return okRes({ result = false }) end
    local base = math.floor(tonumber(e[1]) or 0)
    if (tonumber(data.is_new) or 0) ~= 0 then e[1] = base | EQUIP_NEW_MASK else e[1] = base & ~EQUIP_NEW_MASK end
    return okRes({ result = true }), { EQUIP = eq }
  end,

  -- equip_module.RequestSetLock (lua:1710-1731) sends {id, is_lock} and,
  -- on result, sets or clears LOCK_MASK (bit 30) in base_value itself.
  ["EQUIP.SET_LOCK"] = function(data)
    data = tbl(data)
    local eq = moduleState("EQUIP")
    eq.el = tbl(eq.el)
    local e = eq.el[tostring(math.floor(tonumber(data.id) or 0))]
    if type(e) ~= "table" then return okRes({ result = false }) end
    local base = math.floor(tonumber(e[1]) or 0)
    if (tonumber(data.is_lock) or 0) ~= 0 then e[1] = base | EQUIP_LOCK_MASK else e[1] = base & ~EQUIP_LOCK_MASK end
    print("[OFFLINE] EQUIP.SET_LOCK " .. ser(data) .. " " .. base .. " -> " .. e[1])
    return okRes({ result = true }), { EQUIP = eq }
  end,
  -- equip_module.RequestDecompose (lua:1672-1684) sends {list = {euid, ...}}
  -- and shows res.reward via ON_GET_ITEMS. The yield is the client's own
  -- GetAllDecomposeResult (coin, enhance material, ascend material refunds).
  ["EQUIP.DECOMPOSE"] = function(data)
    data = tbl(data)
    local eq = moduleState("EQUIP")
    eq.el = tbl(eq.el)
    local list = {}
    for _, id in ipairs(tbl(data.list)) do
      local uid = tostring(math.floor(tonumber(id) or 0))
      local e = eq.el[uid]
      if type(e) ~= "table" then return failRes("EQUIP.DECOMPOSE no equipment " .. uid) end
      if (math.floor(tonumber(e[1]) or 0) & EQUIP_LOCK_MASK) ~= 0 then
        return failRes("EQUIP.DECOMPOSE locked " .. uid)
      end
      list[#list + 1] = uid
    end
    if #list == 0 then return failRes("EQUIP.DECOMPOSE empty list") end
    local ok, results = pcall(function() return _ENV.EquipModule:GetAllDecomposeResult(list) end)
    if not ok or type(results) ~= "table" or #results ~= #list then
      return failRes("EQUIP.DECOMPOSE yield unavailable " .. ser(results) .. " for " .. ser(list))
    end
    local total, order = {}, {}
    for _, r in ipairs(results) do
      for _, x in ipairs(tbl(r)) do
        if x.id ~= nil then
          if total[x.id] == nil then order[#order + 1] = x.id end
          total[x.id] = (total[x.id] or 0) + (tonumber(x.count) or 0)
        end
      end
    end
    local entries = {}
    for _, id in ipairs(order) do entries[#entries + 1] = { id = id, count = total[id] } end
    local sync = { EQUIP = eq }
    local grantable, bad = rewardsGrantable(entries)
    if not grantable then return failRes("EQUIP.DECOMPOSE reward unresolved " .. tostring(bad)) end
    for _, uid in ipairs(list) do eq.el[tostring(math.floor(tonumber(uid)))] = nil end
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] EQUIP.DECOMPOSE " .. ser(list) .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,

  -- technology_module (lua:268-347): START_RESEARCH {id} puts
  -- ct[group] = {id, time = finish}; UPGRADE {id} after that time and
  -- QUICK_UPGRADE {id} for gems raise the level; STOP_RESEARCH {group}
  -- refunds. Costs and durations come from the module's GetResearchCost.
  ["TECHNOLOGY.START_RESEARCH"] = function(data)
    data = tbl(data)
    local id = tostring(data.id or "")
    local cfg = _ENV.ConfigMgr:GetTechnologyConfig(id)
    if type(cfg) ~= "table" then return failRes("TECHNOLOGY.START_RESEARCH unknown " .. id) end
    local tech = moduleState("TECHNOLOGY")
    tech.ct = tbl(tech.ct)
    if tech.ct[cfg.group] then return failRes("TECHNOLOGY.START_RESEARCH group busy " .. tostring(cfg.group)) end
    local level = tonumber(_ENV.TechnologyModule:GetTechLevel(id)) or 0
    if level >= (tonumber(cfg.maxLevel) or 1) then return failRes("TECHNOLOGY.START_RESEARCH max level " .. id) end
    local costType = tostring(cfg.cost_type or "coin")
    local cost = techCost(id, "coin") or 0
    local secs = techCost(id, "time") or 0
    local sync = { TECHNOLOGY = tech }
    local paid, short = spend(sync, { [costType] = cost })
    if not paid then return failRes("TECHNOLOGY.START_RESEARCH short of " .. tostring(short)) end
    tech.ct[cfg.group] = { id = id, time = os.time() + math.max(0, math.floor(secs)) }
    print("[OFFLINE] TECH start " .. id .. " cost=" .. cost .. " secs=" .. secs)
    return okRes(), sync
  end,
  ["TECHNOLOGY.UPGRADE"] = function(data)
    data = tbl(data)
    local id = tostring(data.id or "")
    local cfg = _ENV.ConfigMgr:GetTechnologyConfig(id)
    local tech = moduleState("TECHNOLOGY")
    tech.ct = tbl(tech.ct)
    local cur = type(cfg) == "table" and tech.ct[cfg.group]
    if type(cur) ~= "table" or cur.id ~= id then return failRes("TECHNOLOGY.UPGRADE not researching " .. id) end
    if (tonumber(cur.time) or 0) > os.time() + 2 then return failRes("TECHNOLOGY.UPGRADE not finished " .. id) end
    tech.tl = tbl(tech.tl)
    local level = (tonumber(_ENV.TechnologyModule:GetTechLevel(id)) or 0) + 1
    if not setTechLevel(tech.tl, cfg, level) then return failRes("TECHNOLOGY.UPGRADE save_group " .. tostring(cfg.save_group)) end
    tech.ct[cfg.group] = nil
    return okRes(), { TECHNOLOGY = tech }
  end,
  ["TECHNOLOGY.QUICK_UPGRADE"] = function(data)
    data = tbl(data)
    local id = tostring(data.id or "")
    local cfg = _ENV.ConfigMgr:GetTechnologyConfig(id)
    local tech = moduleState("TECHNOLOGY")
    tech.ct = tbl(tech.ct)
    local cur = type(cfg) == "table" and tech.ct[cfg.group]
    if type(cur) ~= "table" or cur.id ~= id then return failRes("TECHNOLOGY.QUICK_UPGRADE not researching " .. id) end
    local sync = { TECHNOLOGY = tech }
    local gemId = (_ENV.GameDef.ITEM_ID or {}).GEM or "gem"
    local paid, short = spend(sync, { [gemId] = techCost(id, "gem") or 0 })
    if not paid then return failRes("TECHNOLOGY.QUICK_UPGRADE short of " .. tostring(short)) end
    tech.tl = tbl(tech.tl)
    local level = (tonumber(_ENV.TechnologyModule:GetTechLevel(id)) or 0) + 1
    if not setTechLevel(tech.tl, cfg, level) then return failRes("TECHNOLOGY.QUICK_UPGRADE save_group " .. tostring(cfg.save_group)) end
    tech.ct[cfg.group] = nil
    return okRes(), sync
  end,
  ["TECHNOLOGY.STOP_RESEARCH"] = function(data)
    data = tbl(data)
    local tech = moduleState("TECHNOLOGY")
    tech.ct = tbl(tech.ct)
    local cur = tech.ct[data.group]
    if type(cur) ~= "table" then return failRes("TECHNOLOGY.STOP_RESEARCH idle " .. tostring(data.group)) end
    local cfg = _ENV.ConfigMgr:GetTechnologyConfig(cur.id) or {}
    local costType = tostring(cfg.cost_type or "coin")
    tech.ct[data.group] = nil
    local sync = { TECHNOLOGY = tech }
    local reward = grantRewards({ { id = costType, count = techCost(cur.id, "coin") or 0 } }, sync)
    return okRes({ reward = reward }), sync
  end,

  -- player_module.RequestSign / RequestDailyGift (lua:282-316).
  ["PLAYER.SIGN"] = function()
    local p = moduleState("PLAYER")
    local d = today()
    if (tonumber(p.lsd) or 0) >= d then return failRes("PLAYER.SIGN already signed " .. d) end
    p.tst = (tonumber(p.tst) or 0) + 1
    p.lsd = d
    local row = signRow(p.tst)
    local sync = { PLAYER = p }
    local reward = grantRewards(rewardEntries(seq(row and row.signReward)), sync)
    print("[OFFLINE] SIGN day " .. p.tst .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  ["PLAYER.DAILY_GIFT"] = function()
    local p = moduleState("PLAYER")
    if (tonumber(p.dg) or 0) == 1 then return failRes("PLAYER.DAILY_GIFT already claimed") end
    p.dg = 1
    local row = signRow(tonumber(p.tst) or 1)
    local sync = { PLAYER = p }
    local reward = grantRewards(rewardEntries(seq(row and row.dailyGift)), sync)
    print("[OFFLINE] DAILY_GIFT reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  ["PLAYER.DAILY_RESET"] = function()
    local p = moduleState("PLAYER")
    p.dg = 0
    local shop = moduleState("SHOP")
    shop.tph = {}
    shop.tsl = {}
    ensureShops(shop)
    return okRes(), { PLAYER = p, SHOP = shop }
  end,

  -- Offline there is no ad network. GM.f carries GameDef.FLAG.NO_AD, which
  -- GMModule.IsNoADForCS reports to AdRewardMgr; these answer the client's
  -- own ad bookkeeping if it still asks.
  ["AD.REQUEST"] = function()
    return okRes({ time = os.time(), token = 1 })
  end,
  ["AD.VERIFY"] = function()
    return okRes()
  end,
  ["GUIDE.STEP_FINISH"] = function(data)
    data = type(data) == "table" and data or {}
    return { ret_code = protoCode("SUCCESS", 1) }, { GUIDE = setGuideFlags({ data.step }) }
  end,
  ["GUIDE.SET_GUIDE_STEP_LIST"] = function(data)
    data = type(data) == "table" and data or {}
    return { ret_code = protoCode("SUCCESS", 1) }, { GUIDE = setGuideFlags(data.step_list) }
  end,
  -- Sent by the C# battle UI through SendRequest4CS: REFRESH_TCO {method,
  -- arg} rerolls the skill choice (the "Ad" refresh button), REVIVE and
  -- FREE_REVIVE bring the hero back. The battle rolls and revives locally;
  -- the server only acknowledges, and offline there is no ad to watch.
  ["BATTLE.REFRESH_TCO"] = function(data)
    print("[OFFLINE] BATTLE.REFRESH_TCO " .. ser(data))
    return okRes()
  end,
  ["BATTLE.REVIVE"] = function(data)
    print("[OFFLINE] BATTLE.REVIVE " .. ser(data))
    return okRes()
  end,
  ["BATTLE.FREE_REVIVE"] = function(data)
    print("[OFFLINE] BATTLE.FREE_REVIVE " .. ser(data))
    return okRes()
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

-- custom_data_module.lua:87-113: Update writes PlayerPrefs, which a
-- force-stop can lose, and only sends BASE.CUSTOM_UPDATE after a debounce
-- timer. Equip slots (equip_mgr SavePlan -> "equip_plan_%d") live there, so
-- mirror each write into the saved profile at once.
local function patchCustomData()
  local cdm = _ENV.CustomDataModule
  if type(cdm) ~= "table" or cdm.__offline_mirror or type(cdm.Update) ~= "function" then return end
  local orig = cdm.Update
  cdm.Update = function(self, key, value, ...)
    local r = orig(self, key, value, ...)
    local st = NetAgent.state
    local cd = type(self) == "table" and type(self.custom_data) == "table" and self.custom_data
    if type(st) == "table" and cd and key ~= nil then
      local c = type(st.CUSTOM) == "table" and st.CUSTOM or {}
      c.d = type(c.d) == "table" and c.d or {}
      c.d[key] = type(cd.d) == "table" and cd.d[key] or nil
      c.lut = tonumber(cd.lut) or os.time()
      st.CUSTOM = c
      saveState()
    end
    return r
  end
  cdm.__offline_mirror = true
end

function NetAgent:SendRequest(group, name, data, cb)
  print("[OFFLINE] SendRequest group=" .. tostring(group) .. " name=" .. tostring(name))
  patchCustomData()
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
