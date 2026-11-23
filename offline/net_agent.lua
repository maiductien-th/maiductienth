-- Offline replacement for net/net_agent.lua: answers client requests from
-- local state saved under the app's files dir; nothing goes over the network.
local NetAgent = {}
local function tbl(v) return type(v) == "table" and v or {} end
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

-- DEV=1 test builds only: run Lua dropped (as root) into the files dir.
local DEV_EVAL = false
local DEV_EVAL_PATH = "/data/data/com.fattoy.swordash.android/files/offline_eval.lua"
local devTick = 0
local function devEval()
  devTick = devTick + 1
  if devTick % 30 ~= 0 then return end
  local f = io.open(DEV_EVAL_PATH, "r")
  if not f then return end
  local code = f:read("a")
  f:close()
  os.remove(DEV_EVAL_PATH)
  local fn, err = load(code, "offline_eval", "t", _ENV)
  local ok, res = false, err
  if fn then ok, res = pcall(fn) end
  print("[OFFLINE] EVAL ok=" .. tostring(ok) .. " " .. tostring(res))
end

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
  if DEV_EVAL then devEval() end
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
-- tools/build_offline_apk.sh sets this to true for the offline-menu variant.
local MENU_BUILD = false
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
    if type(st.HUNTER) == "table" then st.HUNTER.dr = 0 end
    -- vip_module.CanClaimDailyReward: an active card (mc[id].ft >= today)
    -- can claim while ccd > 0.
    if type(st.VIP) == "table" and type(st.VIP.mc) == "table" then
      for _, c in pairs(st.VIP.mc) do
        if type(c) == "table" and (tonumber(c.ft) or 0) >= day then c.ccd = 1 end
      end
    end
    print("[OFFLINE] new day " .. tostring(lastDay) .. " -> " .. tostring(day))
  end
  st._day = day
  -- Real-money packs are bought with the "money" (voucher) resource when
  -- CanBuyProductByMoney allows it; offline that balance never runs out
  -- and ECO_PURCHASE does not charge it.
  if type(st.ECO) == "table" then
    st.ECO.d = type(st.ECO.d) == "table" and st.ECO.d or {}
    st.ECO.d.money = 99999999
  end
  if MENU_BUILD then
    st._cheat = saved and type(saved._cheat) == "table" and saved._cheat or {}
    -- GMModule.IsGM (GameDef.FLAG.GM = 1) makes login_mgr open the GM panel,
    -- which lists the offline menu below.
    if type(st.GM) == "table" then st.GM.f = (tonumber(st.GM.f) or 0) | 1 end
  end
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

-- Requests can be handled before the previous response is published, so a
-- handler's sync is committed to the state at once; fireSync later sends the
-- delta against the state the handler started from.
local function commitSync(partials)
  local prevs = {}
  if type(partials) ~= "table" or not NetAgent.state then return prevs end
  for name, part in pairs(partials) do
    prevs[name] = deepcopy(NetAgent.state[name])
    NetAgent.state[name] = deepcopy(part)
  end
  return prevs
end

local function fireSync(agent, partials, prevs)
  if type(partials) ~= "table" then return end
  local md, mgr = _ENV.ModuleDef, _ENV.RemoteModuleMgr
  local out, n = {}, 0
  for i, m in ipairs(md.SYNC) do
    local part = partials[m.name]
    if part ~= nil then
      local prev
      if prevs then
        prev = prevs[m.name]
      else
        prev = NetAgent.state and NetAgent.state[m.name]
        if NetAgent.state then NetAgent.state[m.name] = deepcopy(part) end
      end
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

-- pet_module: pet config index (base_value >> 10) from a pool row name /
-- choose key, which is the pet's server_id.
local function petTemplateId(key)
  -- item_choose keys ("pet_1_1") map to a row whose name is the server_id;
  -- pool rows are bare ids
  local k = tostring(key or "")
  local n
  for _, grp in pairs(_ENV.ConfigMgr:GetConfig("item_choose") or {}) do
    local row = type(grp) == "table" and grp[k]
    if type(row) == "table" and row.type == "pet" then
      n = tonumber(row.name)
      break
    end
  end
  n = n or tonumber(k:match("^pet_(%d+)") or k:match("(%d+)$"))
  if not n then return nil end
  local cm = _ENV.ConfigMgr
  local ok, tid = pcall(cm.GetPetTemplateIdByServerId, cm, n)
  tid = ok and tonumber(tid) or n
  local ok2, c = pcall(cm.GetPetConfig, cm, tid)
  return ok2 and type(c) == "table" and tid or nil
end

-- pet_module._GetPetMaxEnergy(pet_row, level, distribution); full energy for
-- a new or recharged pet.
local function petMaxEnergy(row)
  local b, g = tonumber(row[1]) or 0, tonumber(row[2]) or 0
  local ok, v = pcall(_ENV.PetModule._GetPetMaxEnergy, _ENV.PetModule, row, b & 0x3ff, g & 0xffff)
  return ok and tonumber(v) and math.floor(v) or 100
end

-- pet_module grade thresholds (PET_QUALITY good/rare/epic/legend).
local function petGrade(dist)
  local g = 0
  for _, t in ipairs({ 1837, 2946, 4336, 6180 }) do if dist >= t then g = g + 1 end end
  return g
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

-- reward_pool rows: {id = pool id, weight, type = item|equip|pool, name,
-- param}. RandomItem items (random_core, gem boxes) carry
-- params.pool_id; each unit rolls one row of that pool.
local function poolRows(poolId)
  local out = {}
  local function add(r)
    if type(r) ~= "table" then return end
    if r.id == poolId and r.name ~= nil then out[#out + 1] = r
    elseif r.id == nil then for _, x in pairs(r) do if type(x) == "table" and x.id == poolId then out[#out + 1] = x end end end
  end
  -- reward_pool is keyed by pool id (ConfigMgr:GetRewardPoolConfig) and
  -- each value is the pool's row list; rows need not repeat the id.
  local ok, pool = pcall(function() return _ENV.ConfigMgr:GetRewardPoolConfig(poolId) end)
  if ok and type(pool) == "table" then
    if pool.name ~= nil then out[#out + 1] = pool
    else
      for _, x in pairs(pool) do
        if type(x) == "table" and x.name ~= nil then out[#out + 1] = x end
      end
    end
  end
  if #out == 0 then
    for _, r in pairs(_ENV.ConfigMgr:GetConfig("reward_pool") or {}) do add(r) end
  end
  if #out == 0 then print("[OFFLINE] reward pool " .. tostring(poolId) .. " empty: " .. ser(pool)) end
  return out
end

local function poolEntry(r)
  local n = math.max(1, math.floor(tonumber(r.param) or 1))
  if r.type == "equip" then return { id = "gift_equip", count = 1, args = tostring(r.name) } end
  if r.type == "pet" then return { id = "gift_pet", count = 1, args = tostring(r.name) } end
  return { id = tostring(r.name), count = n }
end

-- all = true lists every possible outcome (for rewardsGrantable).
local function expandRandom(entries, all, depth)
  depth = depth or 0
  local items = _ENV.ConfigMgr:GetConfig("item") or {}
  local out = {}
  for _, e in ipairs(entries) do
    local cfg = items[e.id]
    if cfg == nil then
      local ok, c = pcall(function() return _ENV.ConfigMgr:GetItemConfig(e.id) end)
      if ok then cfg = c end
    end
    local pid = e.__pool or type(cfg) == "table" and cfg.type == "RandomItem" and type(cfg.params) == "table" and cfg.params.pool_id
    if pid and depth < 4 then
      local rows = poolRows(pid)
      local picks = {}
      if all then picks = rows
      elseif #rows > 0 then
        for _ = 1, math.floor(e.count or 1) do
          local total = 0
          for _, r in ipairs(rows) do total = total + (tonumber(r.weight) or 1) end
          local roll = math.random() * total
          local pick = rows[#rows]
          for _, r in ipairs(rows) do
            roll = roll - (tonumber(r.weight) or 1)
            if roll <= 0 then pick = r break end
          end
          picks[#picks + 1] = pick
        end
      end
      if #rows == 0 then out[#out + 1] = e end
      for _, r in ipairs(picks) do
        local sub = r.type == "pool" and { id = "__pool", pool = tostring(r.name) } or poolEntry(r)
        if sub.id == "__pool" then
          for _, x in ipairs(expandRandom({ { id = "__p", count = 1, __pool = sub.pool } }, all, depth + 1)) do out[#out + 1] = x end
        else
          for _, x in ipairs(expandRandom({ sub }, all, depth + 1)) do out[#out + 1] = x end
        end
      end
    elseif type(cfg) == "table" and type(cfg.params) == "table"
        and (cfg.type == "RandomEconomic" or cfg.type == "ServerRandom") then
      -- RandomEconomic {id, min, max}; ServerRandom {item, args = {min, max}}
      local p = cfg.params
      local rid = p.id or p.item
      local lo = math.floor(tonumber(p.min) or tonumber(tbl(p.args)[1]) or 1)
      local hi = math.max(lo, math.floor(tonumber(p.max) or tonumber(tbl(p.args)[2]) or lo))
      local n = 0
      for _ = 1, math.floor(e.count or 1) do n = n + (all and lo or math.random(lo, hi)) end
      out[#out + 1] = { id = tostring(rid), count = n }
    elseif type(cfg) == "table" and cfg.type == "SpecEquipment" and e.args then
      -- fixed piece (args = equipment name); a quality rolled by the caller
      -- (box, stage drop) wins over params.distribution
      out[#out + 1] = { id = "gift_equip", count = math.floor(e.count or 1), args = e.args,
        dist = tonumber(e.dist) or type(cfg.params) == "table" and tonumber(cfg.params.distribution) or nil }
    elseif type(cfg) == "table" and (cfg.type == "SpecPet" or cfg.type == "Pet") and e.args then
      -- args = pet template (pool_pet row name / choose key); SpecPet fixes
      -- the quality, Pet rolls it up to params[1].
      local pr = type(cfg.params) == "table" and cfg.params or {}
      local dist, grade = tonumber(pr.distribution), tonumber(pr.grade)
      if not dist then dist = math.random(1000, math.max(1000, math.floor(tonumber(pr[1]) or 6000))) end
      out[#out + 1] = { id = "gift_pet", count = math.floor(e.count or 1), args = e.args, dist = dist, grade = grade }
    elseif type(cfg) == "table" and cfg.type == "ReplaceItem" and type(cfg.params) == "table"
        and type(cfg.params.raw) == "table" then
      -- the replacement only applies once the condition (e.g. noAD) is owned
      local raw = cfg.params.raw
      out[#out + 1] = { id = tostring(raw.id), count = math.floor((tonumber(raw.count) or 1) * (e.count or 1)) }
    else
      out[#out + 1] = e
    end
  end
  return out
end

-- True when grantRewards knows how to grant every entry; callers that
-- charge for a reward check this first so nothing is paid for nothing.
local function rewardsGrantable(entries)
  entries = expandRandom(entries, true)
  local items = _ENV.ConfigMgr:GetConfig("item") or {}
  for _, e in ipairs(entries) do
    local cfg = items[e.id]
    local kind = type(cfg) == "table" and cfg.type
    if e.id == "gift_equip" then
      if not equipTemplateId(e.args) then return false, e.args end
    elseif e.id == "gift_pet" then
      if not petTemplateId(e.args) then return false, e.args end
    elseif kind ~= "Economic" and kind ~= "Energy" and kind ~= "Capacity"
        and kind ~= "PetCapacity" and kind ~= "MonthCard" and kind ~= "MonthCardTrial" and kind ~= "Skin"
        and kind ~= "NoAD" and not realIdOf(e.id) then
      return false, e.id
    end
  end
  return true
end

-- achievement_module reads server-kept counters from ACHIEVEMENT.dr
-- [recordKey]: 1 coin gained, 2 energy used, 4 boxes opened, 6 sweeps,
-- 7 gems spent, 10 pieces decomposed, 12/13 epic/legend pieces gained.
local function bumpRecord(sync, key, n)
  if (n or 0) <= 0 then return end
  local ach = sync.ACHIEVEMENT or moduleState("ACHIEVEMENT")
  ach.dr = type(ach.dr) == "table" and ach.dr or {}
  ach.dr[key] = (tonumber(ach.dr[key]) or 0) + n
  sync.ACHIEVEMENT = ach
end
OFFLINE_LAST_BOX = {}

local function grantRewards(entries, sync)
  entries = expandRandom(entries, false)
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
        local uids = {}
        for _ = 1, n do
          local euid = math.floor(tonumber(eq.euid) or 1)
          eq.el[tostring(euid)] = { [1] = (tid << 16) | (1 << 8) | 1 | EQUIP_NEW_MASK,
            [2] = math.max(1, math.floor(tonumber(e.dist) or 1)), [3] = {}, [5] = 0 }
          eq.euid = euid + 1
          uids[#uids + 1] = tostring(euid)
        end
        -- Shown as the gift_equip item (SpecEquipment) with the piece in args;
        -- equipment names have no ItemConfig row of their own. uids lists the
        -- created pieces for callers that report them one by one.
        local d = math.floor(tonumber(e.dist) or 1)
        if d >= 3300 then bumpRecord(sync, 13, n) elseif d >= 2600 then bumpRecord(sync, 12, n) end
        shown[#shown + 1] = { id = "gift_equip", count = n, args = tostring(e.args), uids = uids, tid = tid,
          dist = math.max(1, math.floor(tonumber(e.dist) or 1)) }
      else
        print("[OFFLINE] reward UNRESOLVED equipment " .. tostring(e.args))
      end
    elseif id == "gift_pet" then
          -- PET.pl[pet_id] = {base_value, grade_data, skill_list, energy}:
      -- base_value level | tid << 10, grade_data distribution | grade << 16.
      local tid = petTemplateId(e.args)
      if tid then
        sync.PET = sync.PET or moduleState("PET")
        local pet = sync.PET
        pet.pl = tbl(pet.pl)
        local uids = {}
        for _ = 1, n do
          local uid = 0
          for k in pairs(pet.pl) do uid = math.max(uid, tonumber(k) or 0) end
          uid = tostring(uid + 1)
          local dist = math.max(1, math.floor(tonumber(e.dist) or 1000))
          local grade = math.floor(tonumber(e.grade) or petGrade(dist))
          local row = { [1] = 1 | (tid << 10), [2] = dist | (grade << 16), [3] = {}, [4] = 100 }
          row[4] = petMaxEnergy(row)
          pet.pl[uid] = row
          uids[#uids + 1] = uid
          print("[OFFLINE] pet granted " .. uid .. " tid=" .. tid .. " dist=" .. dist .. " grade=" .. grade)
        end
        -- OwnedPet reward rows carry the created pet_id as args
        for _, u in ipairs(uids) do shown[#shown + 1] = { id = "mypet", count = 1, args = u } end
      else
        print("[OFFLINE] reward UNRESOLVED pet " .. tostring(e.args))
      end
    elseif type(cfg) == "table" and cfg.type == "NoAD" then
      -- GM.f already carries NO_AD offline; nothing else to store.
      shown[#shown + 1] = { id = id, count = n }
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
    elseif type(cfg) == "table" and (cfg.type == "MonthCard" or cfg.type == "MonthCardTrial") then
      -- vip_module_month_card: VIP.mc[card].ft is the last active date
      -- (GetDateNumber form); ccd > 0 lets today's daily gift be claimed.
      local cid = type(cfg.params) == "table" and tostring(cfg.params.id) or id
      sync.VIP = sync.VIP or moduleState("VIP")
      sync.VIP.mc = type(sync.VIP.mc) == "table" and sync.VIP.mc or {}
      local c = type(sync.VIP.mc[cid]) == "table" and sync.VIP.mc[cid] or {}
      -- ft is inclusive: a new card covers today + 29 days, an active one
      -- extends 30 days past its current last day.
      local base = os.time()
      local ft = tonumber(c.ft) or 0
      local active = ft >= tonumber(os.date("%Y%m%d", base))
      if active then
        base = os.time({ year = ft // 10000, month = ft // 100 % 100, day = ft % 100, hour = 12 })
      end
      local days = math.floor(tonumber(type(cfg.params) == "table" and cfg.params.trial_days) or 30)
      c.ft = tonumber(os.date("%Y%m%d", base + days * 86400 * n - (active and 0 or 86400)))
      c.ccd = 1
      sync.VIP.mc[cid] = c
      shown[#shown + 1] = { id = id, count = n }
    elseif type(cfg) == "table" and cfg.type == "Skin" then
      -- PLAYER.sl is the owned-skin bitset by skin config index
      local idx
      pcall(function() idx = tonumber(_ENV.ConfigMgr:GetSkinConfig(tostring(cfg.params or id)).index) end)
      if idx and idx >= 1 then
        sync.PLAYER = sync.PLAYER or moduleState("PLAYER")
        local sl = tbl(sync.PLAYER.sl)
        local w = (idx - 1) // 32 + 1
        for k = 1, w do sl[k] = sl[k] or 0 end
        sl[w] = sl[w] | (1 << ((idx - 1) % 32))
        sync.PLAYER.sl = sl
        shown[#shown + 1] = { id = id, count = 1 }
      else
        print("[OFFLINE] reward UNRESOLVED skin " .. tostring(id))
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
      if id == "gem" then bumpRecord(sync, 7, n) end
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
local POOL_SHOPS = { "coin", "gem", "rmb", "tb" }
-- The Daily Deal exchange (dynamic shop "2") is priced in dsop, the points
-- the daily deal packs give. Its catalogue only comes from the server, so
-- offline it sells this fixed list: {reward, price, daily limit}.
local DYNAMIC_FALLBACK = {
  ["2"] = {
    { "key_rare|1", "dsop|30", 5 },
    { "key_common|3", "dsop|10", 5 },
    { "stone|100", "dsop|15", 5 },
    { "coin|50000", "dsop|10", 5 },
    { "tdt|2", "dsop|20", 3 },
    { "pdt|1", "dsop|25", 3 },
    { "hb|10", "dsop|20", 3 },
    { "pet_xp|200", "dsop|20", 3 },
  },
}
local dynamicShopRows
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
-- Dynamic shops (shop_module_dynamic): the server sends QueryData
-- dynamic_shop[type] = {data = {{reward, price, limit, limitType}, ...}},
-- the item id is the reward string, and purchases are counted in
-- SHOP.dph[type].h[id] (no limitType) or dph[type][limitType].c[id].
local function itemStr(v)
  if type(v) == "string" then return v end
  local parts = {}
  for _, e in ipairs(rewardEntries(v)) do
    parts[#parts + 1] = e.id .. "|" .. math.floor(e.count) .. (e.args and ("|" .. tostring(e.args)) or "")
  end
  return table.concat(parts, ";")
end
dynamicShopRows = function(shopType)
  local list = {}
  for _, r in pairs(_ENV.ConfigMgr:GetConfig("shop") or {}) do
    if type(r) == "table" and r.shop == shopType and (tonumber(r.hide) or 0) == 0
        and (tonumber(r.bitIndex) or 0) > 0 and r.reward ~= nil and r.price ~= nil then
      list[#list + 1] = r
    end
  end
  table.sort(list, function(a, b) return tonumber(a.bitIndex) < tonumber(b.bitIndex) end)
  local rows = {}
  for _, r in ipairs(list) do
    local lt = r.limitType
    if lt == "" then lt = nil end
    rows[#rows + 1] = { cfg = r, reward = itemStr(r.reward), price = itemStr(r.price),
      limit = math.floor(tonumber(r.dailyLimit) or 999), limitType = lt }
  end
  if #rows == 0 and DYNAMIC_FALLBACK[shopType] then
    for i, r in ipairs(DYNAMIC_FALLBACK[shopType]) do
      rows[i] = { reward = r[1], price = r[2], limit = r[3], limitType = 1, weight = i }
    end
  end
  return rows
end
-- shop limitType 1 counts reset daily, 2 weekly; nothing announces the
-- reset offline, so each dph[type] remembers the day/week it counts for.
local function rollDynamic(d)
  local now = os.time()
  local wday = os.date("*t", now).wday -- 1 = Sunday
  -- the week is keyed by its Monday so it does not split at New Year
  local day = tonumber(os.date("%Y%m%d", now))
  local week = tonumber(os.date("%Y%m%d", now - ((wday + 5) % 7) * 86400))
  if d.dd ~= day then d[1] = nil; d.dd = day end
  if d.wk ~= week then d[2] = nil; d.wk = week end
  return d
end
local function ensureShops(shop)
  shop.tsl = tbl(shop.tsl)
  for _, s in ipairs(POOL_SHOPS) do
    if type(shop.tsl[s]) ~= "table" then shop.tsl[s] = rollShop(s) end
  end
  shop.dph = tbl(shop.dph)
  for _, d in pairs(shop.dph) do
    if type(d) == "table" then rollDynamic(d) end
  end
  return shop
end
NetAgent.ensureShops = ensureShops

-- No drop tables ship with the client (ConfigMgr "drop_group" is nil), so a
-- main-stage win drops one piece from the equipment set of its chapter.
local DROP_SETS = { 150, 200, 250, 300, 350, 400, 450 }
-- Equipment distribution (quality score): Random:normalDistribution(mean,
-- sd, min, max) - 8000, as game_def's drop-rate self-test does; quality is
-- the highest GameDef.QUALITY threshold it reaches (epic 2600, legend 3300).
local function rollDist(spec)
  local u1, u2 = math.random(), math.random()
  if u1 < 1e-9 then u1 = 1e-9 end
  local z = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
  local v = math.floor(spec[1] + z * spec[2])
  if spec[3] and v < spec[3] then v = spec[3] end
  if spec[4] and v > spec[4] then v = spec[4] end
  return math.max(1, v - 8000)
end

-- Box rolls from the equip_box_* item rows: base roll, then protect
-- (pity) rolls keyed by the box config's protectId, counted in BOX.pc.
local BOX_ROLLS = {
  common = { base = { 9600, 500, 8000, 10800 } },
  adv = { base = { 10000, 500, 9400, 11800 },
    protect = { box_adv = { 10900, 100, 10600, 11800 }, box_adv10 = { 10900, 100, 10600, 11800 } } },
  rmb = { base = { 9800, 400, 9400, 11500 }, wish = true,
    protect = { box_epic = { 10600, 400, 10600, 11700 }, box_legend = { 11300, 250, 11300, 12100 } } },
}
local PROTECT_FLOOR = { box_adv = 2600, box_adv10 = 2600, box_epic = 2600, box_legend = 3300 }

local function equipNameById(tid)
  for k, v in pairs(_ENV.ConfigMgr:GetConfig("equipment") or {}) do
    if type(v) == "table" and math.floor(tonumber(v.id) or tonumber(k) or -1) == tid then return v.name end
  end
  return nil
end

local function boxPiece(pool)
  for _ = 1, 8 do
    local got = expandRandom({ { id = "__p", count = 1, __pool = pool } }, false)
    local e = got[1]
    if e and e.id == "gift_equip" and equipTemplateId(e.args) then return e end
  end
  return nil
end

local function stageDrop(cfg)
  local chapter = math.max(1, math.floor(tonumber(cfg and cfg.chapter) or 1))
  local base = DROP_SETS[math.min(chapter, #DROP_SETS)]
  local rows = _ENV.ConfigMgr:GetConfig("equipment") or {}
  local pool = {}
  for _, r in pairs(rows) do
    local id = type(r) == "table" and tonumber(r.id)
    if id and id > base and id <= base + 5 and (tonumber(r.valid) or 0) == 1 then
      pool[#pool + 1] = r.name
    end
  end
  table.sort(pool)
  if #pool == 0 then return nil end
  return { id = "gift_equip", count = 1, args = pool[math.random(#pool)], dist = rollDist({ 9800, 500, 8000 }) }
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
-- purchase_module keeps daily()/weekly()/monthly() in a local table that
-- GetLimitPurchaseCount reads as an upvalue; use the same functions so the
-- stored period number matches what the client compares against.
local function purchasePeriodFn(period)
  if type(period) ~= "string" then return nil end
  local pm = _ENV.PurchaseModule
  local f = type(pm) == "table" and pm.GetLimitPurchaseCount
  if type(f) ~= "function" or type(debug) ~= "table" then return nil end
  for i = 1, 16 do
    local name, v = debug.getupvalue(f, i)
    if name == nil then break end
    if type(v) == "table" and type(rawget(v, period)) == "function" then return v[period] end
  end
  return nil
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

-- hunter_reward_pool: {id, reward, type = common|rare, weight}.
-- The Arch wheel pool ships only as the CSV table in assets/config.ab;
-- ConfigMgr has no zlib copy, so its rows are embedded here.
local HUNTER_REWARD_POOL = {
  { id = "energy", reward = "energy|5", type = "common", weight = 200 },
  { id = "stone", reward = "stone|5", type = "common", weight = 200 },
  { id = "coin", reward = "coin|2000", type = "common", weight = 200 },
  { id = "hb", reward = "hb|6", type = "common", weight = 200 },
  { id = "gem", reward = "gem|10", type = "common", weight = 100 },
  { id = "key_common", reward = "key_common|1", type = "common", weight = 100 },
  { id = "capsule", reward = "capsule|1", type = "common", weight = 100 },
  { id = "key_adv", reward = "key_adv|1", type = "common", weight = 40 },
  { id = "capsule_5", reward = "capsule|5", type = "rare", weight = 20 },
  { id = "key_adv_3", reward = "key_adv|3", type = "rare", weight = 10 },
}
-- The wish-points wheel (Rewinding Treasure, PRIZE_WHEEL_CONFIG[3]) draws
-- 12 slots, rares at 1/5/6/11 (lottery_module.GetLotteryItemList); its pool
-- is server-side, and hunter_reward_pool has only 2 rares.
local WISH_WHEEL_RARES = {
  ["cell_m|5"] = { type = "rare", weight = 10 },
  ["random_core|5"] = { type = "rare", weight = 10 },
}
local function lotteryRows(t)
  local rows = {}
  if t == tonumber((_ENV.GameDef.LOTTERY or {}).wish_points) then
    for str, r in pairs(WISH_WHEEL_RARES) do rows[str] = r end
  end
  local cfg = _ENV.ConfigMgr:GetConfig("hunter_reward_pool")
  if type(cfg) ~= "table" or next(cfg) == nil then cfg = HUNTER_REWARD_POOL end
  for _, r in pairs(cfg) do
    if type(r) == "table" and r.reward ~= nil then
      local str = itemStr(r.reward)
      rows[str] = { type = r.type, weight = tonumber(r.weight) or 1, id = r.id }
    end
  end
  return rows
end
local function lotteryPool(t)
  local common, rare = {}, {}
  local ids = {}
  for str, r in pairs(lotteryRows(t)) do ids[#ids + 1] = { str = str, r = r } end
  table.sort(ids, function(a, b) return a.r.weight > b.r.weight or (a.r.weight == b.r.weight and a.str < b.str) end)
  for _, x in ipairs(ids) do
    if x.r.type == "rare" then
      if #rare < 4 then rare[#rare + 1] = x.str end
    elseif #common < 8 then
      common[#common + 1] = x.str
    end
  end
  return common, rare
end
-- LOTTERY.pw[data_type].tc counts today's free draws used: StatrWheelFree
-- only sends while GetFreeDrawsCount < 1, so the daily reset has to reach
-- the client before the next free spin (QUERY.LOTTERY on panel open).
local function prizeWheelState(t)
  local wcfg = tbl((_ENV.GameDef.PRIZE_WHEEL_CONFIG or {})[t])
  if not wcfg.data_type then return nil end
  local lot = moduleState("LOTTERY")
  lot.pw = tbl(lot.pw)
  local st = tbl(lot.pw[wcfg.data_type])
  lot.pw[wcfg.data_type] = st
  local today = os.date("%Y%m%d")
  if st.fd ~= today then st.fd, st.tc = today, 0 end
  return st, lot
end
local function hunterLevelRow(lv)
  for _, r in ipairs(_ENV.ConfigMgr:GetConfig("hunter_level_reward") or {}) do
    if tonumber(r.level) == lv then return r end
  end
end

local function hunterLevel(h)
  return math.max(1, math.floor(tonumber(h.hd) or 1) & 1023)
end

-- Total exp decides the level: the highest row whose total_exp is reached.
local function hunterAddExp(h, n)
  local hd = math.floor(tonumber(h.hd) or 1)
  local exp = ((hd >> 11) & 2097151) + n
  local lv = 1
  for _, r in ipairs(_ENV.ConfigMgr:GetConfig("hunter_level_reward") or {}) do
    if exp >= (tonumber(r.total_exp) or math.huge) then lv = math.max(lv, math.floor(tonumber(r.level) or 1)) end
  end
  h.hd = (exp << 11) | (hd & 1024) | lv
end

local function hunterFill(h)
  h.bl = tbl(h.bl)
  local maxN = 6
  pcall(function() maxN = tonumber(_ENV.HunterModule:GetMaxBountyCount()) or maxN end)
  local row = hunterLevelRow(hunterLevel(h)) or {}
  local limit = math.max(1, math.floor(tonumber(row.difficulty_limit) or 1))
  local lucky = tonumber(row.lucky_rate) or 0
  local pool = {}
  for id, c in pairs(_ENV.ConfigMgr:GetConfig("bounty") or {}) do
    if type(c) == "table" and (tonumber(c.star) or 99) <= limit then pool[#pool + 1] = tostring(c.id or id) end
  end
  table.sort(pool)
  local n = 0
  for _ in pairs(h.bl) do n = n + 1 end
  while n < maxN and #pool > 0 do
    h.i = math.floor(tonumber(h.i) or 0) + 1
    h.bl[tostring(h.i)] = { t = pool[math.random(#pool)], l = (math.random() * 100 < lucky) and 1 or 0, c = 0 }
    n = n + 1
  end
  h.nrt = 0
end

local function hunterPayout(h, id)
  local b = h.bl[id]
  local entries = {}
  local ok, list = pcall(function() return _ENV.HunterModule:GetHunterReward(id) end)
  if ok and type(list) == "table" then entries = rewardEntries(list) end
  if #entries == 0 then
    local cfg = tbl(tbl(_ENV.ConfigMgr:GetConfig("bounty"))[b.t])
    entries = rewardEntries((tonumber(b.l) or 0) == 1 and cfg.LuckyCompleteReward or cfg.CompleteReward)
  end
  if #entries == 0 or not rewardsGrantable(entries) then return failRes("HUNTER payout " .. id .. " reward unresolved") end
  local star = math.max(1, math.floor(tonumber(tbl(tbl(_ENV.ConfigMgr:GetConfig("bounty"))[b.t]).star) or 1))
  local sync = { HUNTER = h }
  h.bl[id] = nil
  hunterAddExp(h, star * 4)
  local hrd = math.floor(tonumber(h.hrd) or 0)
  h.hrd = ((math.min(65535, ((hrd >> 16) & 65535) + star * 10)) << 16) | (hrd & 65535)
  local reward = grantRewards(entries, sync)
  print("[OFFLINE] HUNTER payout " .. id .. " " .. tostring(b.t) .. " reward=" .. ser(reward) .. " hd=" .. h.hd)
  return okRes({ reward = reward }), sync
end

local RESPONSES
RESPONSES = {
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
  -- activity_module_chest reads activity_pool.CHEST.data.id (an activity_chest
  -- row) to find its exchange table; only the CHEST activity runs offline.
  -- Player chest state is ACTIVITY.c {el = exchange level, erc = 4-bit
  -- per-index exchange counts}; offline every exchange level is unlocked.
  ["QUERY.SYNC_ACTIVITY"] = function(data)
    if tostring(tbl(data).type) ~= "CHEST" then return { ret_code = protoCode("SUCCESS", 1), data = "{}" } end
    local now = os.time()
    pcall(function() now = tonumber(_ENV.TimeMgr:GetCurrentServerTime()) or now end)
    -- condition_mgr.activityOpenTime parses ConfigMgr.activity_chest as
    -- "<x>:YYYYMMDDhhmm|..." (normally server config); open it from 2020.
    _ENV.ConfigMgr.activity_chest = _ENV.ConfigMgr.activity_chest or "offline:202001010000|209912312359"
    local act = moduleState("ACTIVITY")
    act.c = tbl(act.c)
    if type(act.c.id) ~= "string" or act.c.id == "" then act.c.id = "act1" end
    act.c.el = math.max(tonumber(act.c.el) or 0, 5)
    act.c.erc = tbl(act.c.erc)
    -- Exchange allowances renew with the weekly period; keep the advertised
    -- deadlines stable and clear the counts once the week has passed.
    if (tonumber(act.c.wn) or 0) <= now then
      if act.c.wn then act.c.erc = {} end
      act.c.wn = now + 7 * 86400
    end
    if (tonumber(act.c.dn) or 0) <= now then act.c.dn = now + 86400 end
    local body = { data = { id = act.c.id }, daily_next_time = act.c.dn, weekly_next_time = act.c.wn }
    print("[OFFLINE] QUERY.SYNC_ACTIVITY CHEST id=" .. tostring(act.c.id) .. " el=" .. tostring(act.c.el))
    return { ret_code = protoCode("SUCCESS", 1), data = ser(body) }, { ACTIVITY = act }
  end,
  ["ACTIVITY.CLAIM_EXCHANGE"] = function(data)
    data = tbl(data)
    local id, count = tostring(data.id or ""), math.max(1, math.floor(tonumber(data.count) or 1))
    local act = moduleState("ACTIVITY")
    act.c = tbl(act.c)
    act.c.erc = tbl(act.c.erc)
    local chest = _ENV.ConfigMgr:GetActivityChestById(act.c.id or "act1")
    local cfg = type(chest) == "table" and _ENV.ConfigMgr:GetChestExchangeById(chest.exchange_reward_path, id)
    if type(cfg) ~= "table" then return failRes("ACTIVITY.CLAIM_EXCHANGE unknown " .. id) end
    local idx = math.floor(tonumber(cfg.index) or 0)
    local used = getBits(act.c.erc, idx, 4)
    if (tonumber(act.c.el) or 0) < (tonumber(cfg.level) or 0) then return failRes("ACTIVITY.CLAIM_EXCHANGE " .. id .. " locked") end
    if used + count > (tonumber(cfg.limit) or 0) then return failRes("ACTIVITY.CLAIM_EXCHANGE " .. id .. " limit") end
    local entries = {}
    for _ = 1, count do
      for _, e in ipairs(rewardEntries(cfg.reward)) do entries[#entries + 1] = e end
    end
    if #entries == 0 then return failRes("ACTIVITY.CLAIM_EXCHANGE " .. id .. " no reward") end
    local sync = { ACTIVITY = act }
    local price = tbl(cfg.price)
    if price.id ~= nil then
      local paid, short = spend(sync, { [tostring(price.id)] = (tonumber(price.count) or 0) * count })
      if not paid then return failRes("ACTIVITY.CLAIM_EXCHANGE short of " .. tostring(short)) end
    end
    setBits(act.c.erc, idx, 4, used + count)
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] ACTIVITY.CLAIM_EXCHANGE " .. id .. " x" .. count .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  -- query_data.QueryLottery stores the whole response as
  -- lottery_pool[type]; lottery_module.GetLotteryItemList reads its
  -- common / rare lists of "id|count|args" strings.
  -- potential_module CheckIncrease / CheckIncreaseTicket ask the server to
  -- apply time-based regen; nothing regenerates offline beyond the synced state.
  ["POTENTIAL.INCREASE"] = function() return okRes() end,
  -- pig_bank_module.CheckNext (lua:55-69) sends PIG_BANK.CHECK_NEXT when no
  -- bank is open (i <= 0) or the open one is older than PIGGY_BANK_DURATION;
  -- success fires PIG_BANK_RESET. The first one goes out on the lobby load
  -- after the stage that unlocks the bank, so an unanswered request leaves
  -- that load on the loading screen. Opening the next bank: index i + 1,
  -- start time st, empty savings cs/ts.
  ["PIG_BANK.CHECK_NEXT"] = function()
    local pb = moduleState("PIG_BANK")
    pb.i = math.max(0, math.floor(tonumber(pb.i) or 0)) + 1
    pb.st, pb.cs, pb.ts = os.time(), 0, 0
    return okRes(), { PIG_BANK = pb }
  end,
  -- CLAIM_REWARD pays out the saved gems (cs) and marks bank i claimed in
  -- the pl bitset (GetBitValue(pl, i, 1): word ceil(i/32), bit (i-1)%32).
  ["PIG_BANK.CLAIM_REWARD"] = function()
    local pb = moduleState("PIG_BANK")
    local i = math.floor(tonumber(pb.i) or 0)
    if i <= 0 then return failRes("PIG_BANK.CLAIM_REWARD no bank") end
    pb.pl = tbl(pb.pl)
    local w, b = (i - 1) // 32 + 1, (i - 1) % 32
    for k = 1, w do pb.pl[k] = tonumber(pb.pl[k]) or 0 end
    if (pb.pl[w] >> b) & 1 == 1 then return failRes("PIG_BANK.CLAIM_REWARD claimed") end
    pb.pl[w] = pb.pl[w] | (1 << b)
    local sync = { PIG_BANK = pb }
    local n = math.floor(tonumber(pb.cs) or 0)
    local reward = n > 0 and grantRewards({ { id = "gem", count = n } }, sync) or {}
    pb.cs = 0
    return okRes({ reward = reward }), sync
  end,
  ["POTENTIAL.INCREASE_TICKET"] = function() return okRes() end,
  ["QUERY.LOTTERY"] = function(data)
    local t = math.floor(tonumber(tbl(data).type) or 0)
    local common, rare = lotteryPool(t)
    local now = 0
    pcall(function() now = tonumber(_ENV.TimeMgr:GetCurrentServerTime()) or 0 end)
    print("[OFFLINE] QUERY.LOTTERY " .. t .. " common=" .. #common .. " rare=" .. #rare)
    local _, lot = prizeWheelState(t)
    return { ret_code = protoCode("SUCCESS", 1), common = common, rare = rare, next_time = now + 86400 },
      lot and { LOTTERY = lot } or nil
  end,
  ["QUERY.DYNAMIC_SHOP"] = function(data)
    local t = tostring(tbl(data).type or "")
    local rows = {}
    for _, r in ipairs(dynamicShopRows(t)) do
      rows[#rows + 1] = { reward = r.reward, price = r.price, limit = r.limit, limitType = r.limitType, weight = r.weight }
    end
    local now = 0
    pcall(function() now = tonumber(_ENV.TimeMgr:GetCurrentServerTime()) or 0 end)
    print("[OFFLINE] QUERY.DYNAMIC_SHOP " .. t .. " items=" .. #rows .. " now=" .. now)
    return { ret_code = protoCode("SUCCESS", 1), data = ser({ data = rows, next_time = now + 86400 }) }
  end,
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
  -- item_choose items (pay_pet_D, choose_pay_weapon, ...): an Economic item
  -- whose params.item is granted with the picked pool row as args.
  ["ITEM.CHOOSE"] = function(data)
    data = type(data) == "table" and data or {}
    local id, key = tostring(data.id or ""), data.choose_key
    local cfg = (_ENV.ConfigMgr:GetConfig("item") or {})[id]
    local eco = moduleState("ECO")
    eco.d = tbl(eco.d)
    if type(cfg) ~= "table" or type(cfg.params) ~= "table" or not cfg.params.item or key == nil then
      return failRes("ITEM.CHOOSE unknown " .. id .. " key=" .. tostring(key))
    end
    if (tonumber(eco.d[id]) or 0) < 1 then return failRes("ITEM.CHOOSE not owned " .. id) end
    local entries = { { id = tostring(cfg.params.item), count = 1, args = tostring(key) } }
    local grantable, bad = rewardsGrantable(entries)
    if not grantable then return failRes("ITEM.CHOOSE reward unresolved " .. tostring(bad)) end
    eco.d[id] = eco.d[id] - 1
    local sync = { ECO = eco }
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] ITEM.CHOOSE " .. id .. " key=" .. tostring(key) .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,

  -- pet_module: bpl[pet_id] = 1 for pets in battle, at most GetPetSlotCount.
  ["PET.SET_BATTLE"] = function(data)
    data = type(data) == "table" and data or {}
    local pet = moduleState("PET")
    pet.pl, pet.bpl = tbl(pet.pl), tbl(pet.bpl)
    local pid = tostring(data.id or "")
    if not pet.pl[pid] then return failRes("PET.SET_BATTLE unknown " .. pid) end
    if (tonumber(data.battle_state) or 0) ~= 0 then
      local slots = 1
      pcall(function() slots = _ENV.PetModule:GetPetSlotCount() end)
      local cnt = 0
      for k in pairs(pet.bpl) do if k ~= pid then cnt = cnt + 1 end end
      if cnt >= slots then
        -- one slot: swap the pet in battle for the new one
        if slots <= 1 then pet.bpl = {} else return failRes("PET.SET_BATTLE no slot") end
      end
      pet.bpl[pid] = 1
    else
      pet.bpl[pid] = nil
    end
    return okRes({ result = 1 }), { PET = pet }
  end,

  -- potential_module: the Seek worker pet is POTENTIAL.sl.pi ("0" = none).
  ["POTENTIAL.SET_ASSIST_PET"] = function(data)
    data = type(data) == "table" and data or {}
    local pid = tostring(data.id or "0")
    local pet = moduleState("PET")
    if pid ~= "0" and not tbl(pet.pl)[pid] then
      return failRes("POTENTIAL.SET_ASSIST_PET unknown " .. pid)
    end
    local pot = moduleState("POTENTIAL")
    pot.sl = tbl(pot.sl)
    pot.sl.pi = pid ~= "0" and pid or 0
    return okRes(), { POTENTIAL = pot }
  end,
  -- Offline there is no shop for pet energy: recharging refills to max for free.
  ["PET.ADD_ENERGY"] = function(data)
    local pet = moduleState("PET")
    local e = tbl(pet.pl)[tostring(type(data) == "table" and data.id or "")]
    if type(e) ~= "table" then return failRes("PET.ADD_ENERGY unknown") end
    e[4] = petMaxEnergy(e)
    return okRes(), { PET = pet }
  end,
  ["PET.RECHARGE"] = function(data)
    local pet = moduleState("PET")
    local e = tbl(pet.pl)[tostring(type(data) == "table" and data.id or "")]
    if type(e) ~= "table" then return failRes("PET.RECHARGE unknown") end
    e[4] = petMaxEnergy(e)
    return okRes(), { PET = pet }
  end,
  ["PET.DEAD"] = function() return okRes() end,
  ["PET.REMOVE"] = function(data)
    local pid = tostring(type(data) == "table" and data.id or "")
    local pet = moduleState("PET")
    pet.pl, pet.bpl = tbl(pet.pl), tbl(pet.bpl)
    if not pet.pl[pid] then return failRes("PET.REMOVE unknown " .. pid) end
    pet.pl[pid], pet.bpl[pid] = nil, nil
    local sync = { PET = pet }
    local pot = moduleState("POTENTIAL")
    if type(pot.sl) == "table" and tostring(pot.sl.pi) == pid then
      pot.sl.pi = 0
      sync.POTENTIAL = pot
    end
    return okRes({ reward = {} }), sync
  end,
  ["PET.SET_LOCK"] = function(data)
    data = type(data) == "table" and data or {}
    local pet = moduleState("PET")
    pet.pl = tbl(pet.pl)
    local e = pet.pl[tostring(data.id or "")]
    if type(e) ~= "table" then return failRes("PET.SET_LOCK unknown " .. tostring(data.id)) end
    local b = tonumber(e[1]) or 0
    e[1] = (tonumber(data.lock_state) or 0) ~= 0 and (b | (1 << 30)) or (b & ~(1 << 30))
    return okRes({ result = 1 }), { PET = pet }
  end,

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
    -- hero_module.GetCurrentHeroLevelupCost prices the next level as
    -- GetLevelupCost(id, level + 1) -> ConfigMgr:GetHeroLevelupCost(level + 1).
    -- The UI sends the level the hero is at now; accept the target too.
    if not cur or (level ~= cur and level ~= cur + 1) then
      return failRes("HERO.LEVELUP id=" .. id .. " level=" .. level .. " cur=" .. tostring(cur))
    end
    local ok, costs = pcall(function() return _ENV.HeroModule:GetLevelupCost(id, cur + 1) end)
    if not ok or type(costs) ~= "table" or next(costs) == nil then
      return failRes("HERO.LEVELUP no cost for level " .. (cur + 1) .. " " .. tostring(costs))
    end
    local sync = { HERO = hero }
    local paid, short = spend(sync, costs)
    if not paid then return failRes("HERO.LEVELUP short of " .. tostring(short)) end
    hero.hl[id].l = cur + 1
    print("[OFFLINE] HERO.LEVELUP " .. id .. " " .. cur .. " -> " .. (cur + 1) .. " cost=" .. ser(costs))
    return { ret_code = protoCode("SUCCESS", 1) }, sync
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
    st.bounty = type(data.params) == "table" and data.params.bounty_id or nil
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
        bumpRecord(sync, 2, c.count)
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
    local bountyId = NetAgent.battle and NetAgent.battle.bounty
    NetAgent.battle = nil
    local stars, starReward, reward = 0, {}, {}
    local names = _ENV.BattleModule and _ENV.BattleModule.BATTLE_RESULT
    local result = data.result
    local won = result == 1 or result == "VICTORY" or (type(names) == "table" and names[result] == "VICTORY")
        print("[OFFLINE] OVER stage=" .. tostring(data.stage_id) .. " result=" .. tostring(result) .. " won=" .. tostring(won) .. " coin=" .. tostring(data.coin))
    if won and bountyId then
      local h = moduleState("HUNTER")
      h.bl = tbl(h.bl)
      local b = h.bl[tostring(bountyId)]
      if type(b) == "table" then b.c = 1 sync.HUNTER = h end
    end
    if won then
      local eco = moduleState("ECO")
      eco.d = type(eco.d) == "table" and eco.d or {}
      local coinId = _ENV.GameDef.ITEM_ID and _ENV.GameDef.ITEM_ID.COIN or "coin"
      eco.d[coinId] = (tonumber(eco.d[coinId]) or 0) + math.floor(tonumber(data.coin) or 0)
      sync.ECO = eco
      bumpRecord(sync, 1, math.floor(tonumber(data.coin) or 0))
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
  ["SHOP.PURCHASE_DYNAMIC"] = function(data)
    data = tbl(data)
    local t, id = tostring(data.type or ""), tostring(data.id or "")
    local count = math.max(1, math.floor(tonumber(data.count) or 1))
    local row = dynamicShopRows(t)[math.floor(tonumber(data.index) or 0)]
    if not row or row.reward ~= id then
      return failRes("SHOP.PURCHASE_DYNAMIC " .. t .. " no item " .. id .. " at " .. tostring(data.index))
    end
    local shop = moduleState("SHOP")
    shop.dph = tbl(shop.dph)
    local d = rollDynamic(tbl(shop.dph[t]))
    local bucket
    if row.limitType then
      d[row.limitType] = tbl(d[row.limitType]); d[row.limitType].c = tbl(d[row.limitType].c)
      bucket = d[row.limitType].c
    else
      d.h = tbl(d.h); bucket = d.h
    end
    if (tonumber(bucket[id]) or 0) + count > row.limit then
      return failRes("SHOP.PURCHASE_DYNAMIC limit " .. id)
    end
    local entries = {}
    for _ = 1, count do
      for _, e in ipairs(rewardEntries(row.reward)) do entries[#entries + 1] = e end
    end
    local grantable, missing = rewardsGrantable(entries)
    if not grantable then
      return failRes("SHOP.PURCHASE_DYNAMIC " .. id .. " reward not supported offline: " .. tostring(missing))
    end
    local sync = { SHOP = shop }
    local costs = {}
    for _, e in ipairs(rewardEntries(row.price)) do
      costs[e.id] = (costs[e.id] or 0) + math.floor(e.count) * count
    end
    local paid, short = spend(sync, costs)
    if not paid then return failRes("SHOP.PURCHASE_DYNAMIC " .. id .. " short of " .. tostring(short)) end
    bucket[id] = (tonumber(bucket[id]) or 0) + count
    shop.dph[t] = d
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] SHOP.PURCHASE_DYNAMIC " .. t .. " " .. id .. " x" .. count .. " cost=" .. ser(costs))
    return okRes({ reward = reward }), sync
  end,
  ["SHOP.RESET_DYNAMIC"] = function(data)
    local t = tostring(tbl(data).type or "")
    local shop = moduleState("SHOP")
    shop.dph = tbl(shop.dph)
    shop.dph[t] = rollDynamic(tbl(shop.dph[t]))
    return okRes(), { SHOP = shop }
  end,
  -- lottery_module.StatrWheel sends {type, count, is_free}; per-type state
  -- is LOTTERY.pw[PRIZE_WHEEL_CONFIG[type].data_type] = {c = draws,
  -- tc = free draws, l = lucky value, r = claimed cumulative-reward bits}.
  ["LOTTERY.START_WHEEL"] = function(data)
    data = tbl(data)
    local t = math.floor(tonumber(data.type) or 0)
    local wcfg = tbl((_ENV.GameDef.PRIZE_WHEEL_CONFIG or {})[t])
    local hunter = t == _ENV.GameDef.LOTTERY.hunter_normal or t == _ENV.GameDef.LOTTERY.hunter_special
    if hunter then
      -- Arch (hunter) wheel: hunter_module.GetWheelCost = hb|HUNTER_WHEEL_COST_HB[type].
      wcfg = { data_type = "h" .. t, cost = { id = "hb", cost = tonumber((_ENV.GameDef.HUNTER_WHEEL_COST_HB or {})[t]) or 0 } }
    end
    if not wcfg.data_type then return failRes("LOTTERY.START_WHEEL unknown type " .. t) end
    local count = math.max(1, math.floor(tonumber(data.count) or 1))
    local lot = moduleState("LOTTERY")
    lot.pw = tbl(lot.pw)
    local st = tbl(lot.pw[wcfg.data_type])
    lot.pw[wcfg.data_type] = st
    local sync = { LOTTERY = lot }
    if not hunter then prizeWheelState(t) end
    if data.is_free == true or tonumber(data.is_free) == 1 then
      if (tonumber(st.tc) or 0) >= 1 then return failRes("LOTTERY.START_WHEEL no free draw") end
      st.tc = 1
      count = 1
    else
      local cost = tbl(wcfg.cost)
      local paid, short = spend(sync, { [tostring(cost.id)] = (tonumber(cost.cost) or 0) * count })
      if not paid then return failRes("LOTTERY.START_WHEEL short of " .. tostring(short)) end
    end
    local ok, list = pcall(function()
      if hunter then return _ENV.HunterModule:GetHunterItemList(t) end
      return _ENV.LotteryModule:GetLotteryItemList(t)
    end)
    if hunter and (not ok or type(list) ~= "table" or #list == 0) then
      -- hunter_module.GetHunterItemList reads QueryData's cached QUERY.LOTTERY
      -- answer: 8 commons with the 2 rares at slots 5 and 10.
      local common, rare = lotteryPool()
      list = {}
      local ci, ri = 1, 1
      for pos = 1, #common + math.min(2, #rare) do
        if (pos == 5 or pos == 10) and rare[ri] then
          list[#list + 1] = rare[ri]; ri = ri + 1
        elseif common[ci] then
          list[#list + 1] = common[ci]; ci = ci + 1
        end
      end
      ok = true
    end
    if not ok or type(list) ~= "table" or #list == 0 then
      return failRes("LOTTERY.START_WHEEL no pool for " .. t .. " " .. tostring(list))
    end
    local weights, total = {}, 0
    local rows = lotteryRows(t)
    for i, str in ipairs(list) do
      local r = rows[str]
      weights[i] = r and r.weight or 1
      total = total + weights[i]
    end
    local entries, indexes = {}, {}
    local limit = tonumber(wcfg.lucky_limit) or 0
    for _ = 1, count do
      local pick
      st.l = (tonumber(st.l) or 0) + 1
      if limit > 0 and st.l >= limit then
        for i, str in ipairs(list) do
          if rows[str] and rows[str].type == "rare" then pick = i break end
        end
        st.l = 0
      end
      if not pick then
        local roll = math.random() * total
        for i, w in ipairs(weights) do
          roll = roll - w
          if roll <= 0 then pick = i break end
        end
        pick = pick or #list
      end
      indexes[#indexes + 1] = pick
      for _, e in ipairs(rewardEntries(list[pick])) do entries[#entries + 1] = e end
    end
    st.c = (tonumber(st.c) or 0) + count
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] LOTTERY.START_WHEEL " .. t .. " x" .. count .. " idx=" .. ser(indexes) .. " reward=" .. ser(reward))
    return okRes({ reward = reward, index = indexes[1], indexes = indexes, result = indexes, type = t,
      reward_id = list[indexes[1]], id = list[indexes[1]] }), sync
  end,
  ["LOTTERY.RESET_LOTTERY"] = function() return okRes() end,
  -- hunter_module: HUNTER.hd packs level (bits 0-9) and total exp (bits
  -- 11-31); bl maps a bounty uid to { t = bounty config id, l = lucky,
  -- c = completed }. dr is the daily-reward flag, lrl the claimed-level bits.
  ["HUNTER.REQUEST_BOUNTY"] = function()
    local h = moduleState("HUNTER")
    hunterFill(h)
    print("[OFFLINE] HUNTER.REQUEST_BOUNTY bl=" .. ser(h.bl))
    return okRes(), { HUNTER = h }
  end,
  ["HUNTER.REFRESH_BOUNTY"] = function(data)
    local id = tostring(tbl(data).id or "")
    local h = moduleState("HUNTER")
    h.bl = tbl(h.bl)
    if not h.bl[id] then return failRes("HUNTER.REFRESH_BOUNTY unknown " .. id) end
    h.bl[id] = nil
    hunterFill(h)
    return okRes(), { HUNTER = h }
  end,
  ["HUNTER.ABANDON_BOUNTY"] = function(data)
    local h = moduleState("HUNTER")
    h.bl = tbl(h.bl)
    h.bl[tostring(tbl(data).id or "")] = nil
    return okRes(), { HUNTER = h }
  end,
  ["HUNTER.CLAIM_REWARD"] = function(data)
    local id = tostring(tbl(data).id or "")
    local h = moduleState("HUNTER")
    local b = tbl(tbl(h.bl)[id])
    if (tonumber(b.c) or 0) ~= 1 then return failRes("HUNTER.CLAIM_REWARD " .. id .. " not completed") end
    return hunterPayout(h, id)
  end,
  ["HUNTER.SWEEP_BOUNTY"] = function(data)
    local id = tostring(tbl(data).id or "")
    local h = moduleState("HUNTER")
    if not tbl(h.bl)[id] then return failRes("HUNTER.SWEEP_BOUNTY unknown " .. id) end
    local ok, can = pcall(function() return _ENV.HunterModule:IsCanSweepBounty(id) end)
    if ok and can == 0 then return failRes("HUNTER.SWEEP_BOUNTY " .. id .. " not sweepable") end
    return hunterPayout(h, id)
  end,
  ["HUNTER.CLAIM_DAILY_REWARD"] = function()
    local h = moduleState("HUNTER")
    if (tonumber(h.dr) or 0) ~= 0 then return failRes("HUNTER.CLAIM_DAILY_REWARD already claimed") end
    local row = hunterLevelRow(hunterLevel(h))
    local entries = rewardEntries(row and row.daily_reward)
    if #entries == 0 or not rewardsGrantable(entries) then return failRes("HUNTER.CLAIM_DAILY_REWARD no reward") end
    local sync = { HUNTER = h }
    h.dr = 1
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] HUNTER.CLAIM_DAILY_REWARD reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  ["HUNTER.CLAIM_LEVEL_REWARD"] = function()
    local h = moduleState("HUNTER")
    h.lrl = tbl(h.lrl)
    local lv, entries, levels = hunterLevel(h), {}, {}
    for _, r in ipairs(_ENV.ConfigMgr:GetConfig("hunter_level_reward") or {}) do
      local l = math.floor(tonumber(r.level) or 0)
      if l > 1 and l <= lv and getBits(h.lrl, l, 1) == 0 then
        levels[#levels + 1] = l
        for _, e in ipairs(rewardEntries(r.daily_reward)) do entries[#entries + 1] = e end
      end
    end
    if #levels == 0 or not rewardsGrantable(entries) then return failRes("HUNTER.CLAIM_LEVEL_REWARD nothing to claim") end
    local sync = { HUNTER = h }
    for _, l in ipairs(levels) do setBits(h.lrl, l, 1, 1) end
    local reward = grantRewards(entries, sync)
    return okRes({ reward = reward }), sync
  end,
  ["HUNTER.RESET"] = function() return okRes() end,
  ["HUNTER.CONFIRM"] = function() return okRes() end,
  -- PrizeWheelPanel (Arch wheel) spins through SendRequest4CS HUNTER.START_WHEEL
  -- with the hunter pool type; draws share the LOTTERY wheel logic.
  ["HUNTER.START_WHEEL"] = function(data)
    data = tbl(data)
    print("[OFFLINE] HUNTER.START_WHEEL args=" .. ser(data))
    local t = tonumber(data.type) or tonumber(data[1]) or _ENV.GameDef.LOTTERY.hunter_normal
    return RESPONSES["LOTTERY.START_WHEEL"]({ type = t, count = tonumber(data.count) or 1, is_free = 0 })
  end,
  ["VIP.CLAIM_MONTH_CARD_DAILY_REWARD"] = function(data)
    local cid = tostring(tbl(data).card_id or "")
    local vip = moduleState("VIP")
    vip.mc = tbl(vip.mc)
    local c = tbl(vip.mc[cid])
    if (tonumber(c.ft) or 0) < today() or (tonumber(c.ccd) or 0) <= 0 then
      return failRes("VIP.CLAIM_MONTH_CARD_DAILY_REWARD " .. cid .. " not claimable")
    end
    local ok, gift = pcall(function() return _ENV.VIPModule:GetMonthCardDailyGift(cid) end)
    if not ok or type(gift) ~= "table" then return failRes("VIP.CLAIM_MONTH_CARD_DAILY_REWARD gift " .. tostring(gift)) end
    local entries = {}
    for _, g in ipairs(gift) do
      if type(g) == "table" and g.id then entries[#entries + 1] = { id = tostring(g.id), count = tonumber(g.count) or 1, args = g.args } end
    end
    c.ccd = 0
    vip.mc[cid] = c
    local sync = { VIP = vip }
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] VIP.CLAIM_MONTH_CARD_DAILY_REWARD " .. cid .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  ["LOTTERY.CLAIM"] = function(data)
    local t = math.floor(tonumber(tbl(data).type) or 0)
    local wcfg = tbl((_ENV.GameDef.PRIZE_WHEEL_CONFIG or {})[t])
    local ok, n, states = pcall(function() return _ENV.LotteryModule:GetClaimState(t) end)
    local rcfg = _ENV.ConfigMgr:GetPrizeWheelReward(t)
    if not ok or not wcfg.data_type or type(states) ~= "table" or type(rcfg) ~= "table" then
      return failRes("LOTTERY.CLAIM type " .. t .. " " .. tostring(n))
    end
    local lot = moduleState("LOTTERY")
    lot.pw = tbl(lot.pw)
    local st = tbl(lot.pw[wcfg.data_type])
    lot.pw[wcfg.data_type] = st
    st.r = tbl(st.r)
    local entries = {}
    for idx, state in pairs(states) do
      if state == 1 then
        setBits(st.r, idx, 1, 1)
        for _, e in ipairs(rewardEntries(rcfg["reward_" .. idx])) do entries[#entries + 1] = e end
      end
    end
    if #entries == 0 then return failRes("LOTTERY.CLAIM nothing to claim") end
    local sync = { LOTTERY = lot }
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] LOTTERY.CLAIM " .. t .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,
  -- purchase_module.CreateBillOnServer: offline there is no store billing,
  -- so a real-money pack is granted at once and the bill is reported as
  -- not created, which keeps the client from opening platform billing.
  ["PURCHASE.REQUEST"] = function(data)
    data = tbl(data)
    local sku = tostring(data.sku_id or "")
    local res, sync = RESPONSES["PURCHASE.ECO_PURCHASE"]({ sku_id = sku, __offline_paid = true })
    if tbl(res).ret_code == protoCode("SUCCESS", 1) then
      local reward = res.reward
      pcall(function() _ENV.PurchaseModule:FireEvent("ON_GET_ITEMS", reward) end)
      pcall(function() _ENV.PurchaseModule:FireEvent("PRODUCT_ITEM_UPDATE_" .. sku, res.ret_code) end)
      print("[OFFLINE] PURCHASE.REQUEST " .. sku .. " granted offline")
    end
    return { ret_code = protoCode("SUCCESS", 1), pay_code = -1 }, sync
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
    -- Offline there is no billing, so "money" packs are granted on tap too.
    -- Supply packs priced in an in-game currency (model gem/rmb/tb, price
    -- = amount) are paid from that currency.
    local items = _ENV.ConfigMgr:GetConfig("item") or {}
    local curCfg = items[tostring(cfg.model)]
    local currencyCost = type(curCfg) == "table" and curCfg.type == "Economic"
      and math.floor(tonumber(cfg.price) or 0) or 0
    if not data.__offline_paid and currencyCost <= 0 and cfg.model ~= "video"
        and cfg.model ~= "free" and cfg.model ~= "money" then
      return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " model " .. tostring(cfg.model) .. " needs real billing")
    end
    local entries = {}
    for _, e in ipairs(rewardEntries(seq(cfg.itemList))) do
      local sub = e.id == "sku" and _ENV.ConfigMgr:GetSKUConfig(tostring(e.args))
      if type(sub) == "table" then
        for _ = 1, math.max(1, math.floor(e.count or 1)) do
          for _, x in ipairs(rewardEntries(seq(sub.itemList))) do entries[#entries + 1] = x end
        end
      else
        entries[#entries + 1] = e
      end
    end
    local grantable, missing = rewardsGrantable(entries)
    if not grantable then
      return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " reward not supported offline: " .. tostring(missing))
    end
    if currencyCost > 0 and owned({}, tostring(cfg.model)) < currencyCost then
      return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " short of " .. tostring(cfg.model))
    end
    local pur = moduleState("Purchase")
    local cl = cfg.conditionLimit
    if type(cl) == "table" then
      local period, index, limit = cfgAt(cl, 1), tonumber(cfgAt(cl, 2)), tonumber(cfgAt(cl, 3))
      local fn = purchasePeriodFn(period)
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
    local sync = { Purchase = pur }
    if currencyCost > 0 then
      local paid, short = spend(sync, { [tostring(cfg.model)] = currencyCost })
      if not paid then return failRes("PURCHASE.ECO_PURCHASE " .. sku .. " short of " .. tostring(short)) end
    end
    pur.pcr = tbl(pur.pcr)
    pur.pcr[sku] = (tonumber(pur.pcr[sku]) or 0) + 1
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
    local count = paidCount * math.max(1, math.floor(tonumber(cfg.loopCount) or 1))
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
    local kind = BOX_ROLLS[boxId:match("^box_(%a+)") or ""] or BOX_ROLLS.common
    box.pc = tbl(box.pc)
    local protects = {}
    local ids, counts = seq(cfg.protectId), seq(cfg.protectCount)
    if type(cfg.protectId) == "string" then ids = {} for x in cfg.protectId:gmatch("[^|]+") do ids[#ids + 1] = x end end
    for i, pid in ipairs(ids) do
      local n = math.floor(tonumber(counts[i]) or 0)
      if n > 0 then protects[#protects + 1] = { id = tostring(pid), n = n } end
    end
    table.sort(protects, function(a, b) return a.n > b.n end)
    local wish = kind.wish and math.floor(tonumber(box.we) or 0) or 0
    local wishName = wish > 0 and equipNameById(wish) or nil
    local entries = {}
    -- box_module.GetProtectCount shows BOX.pc[id] as the draws left before
    -- the guarantee, defaulting to protectCount, so it counts down.
    for _ = 1, count do
      local spec, fired = kind.base, nil
      for _, pr in ipairs(protects) do
        local left = math.floor(tonumber(box.pc[pr.id]) or pr.n)
        if left < 1 or left > pr.n then left = pr.n end
        box.pc[pr.id] = left - 1
        if not fired and left <= 1 and kind.protect and kind.protect[pr.id] then
          fired, spec = pr.id, kind.protect[pr.id]
        end
      end
      local dist = rollDist(spec)
      for _, pr in ipairs(protects) do
        if pr.id == fired or box.pc[pr.id] < 1 or dist >= (PROTECT_FLOOR[pr.id] or math.huge) then
          box.pc[pr.id] = pr.n
        end
      end
      local e = boxPiece("pool_all_equipment")
      if e and wishName and dist >= 2600 and (fired or math.random() < 0.5) then e.args = wishName end
      if e then e.dist = dist entries[#entries + 1] = e end
    end
    if #entries < count then return failRes("SHOP.OPEN_BOX " .. boxId .. " no equipment pool") end
    local granted = grantRewards(entries, sync)
    bumpRecord(sync, 4, count)
    OFFLINE_LAST_BOX = {}
    for _, r in ipairs(granted) do
      for _, u in ipairs(tbl(r.uids)) do OFFLINE_LAST_BOX[#OFFLINE_LAST_BOX + 1] = { uid = u, args = r.args } end
    end
    -- BoxItemsPanel reads quality through ItemMgr's executor for the item
    -- id: gift_equip (EquipmentItem) only knows the template name, so every
    -- frame is common. drop_equip (DropEquipmentItem) Int32.TryParses params
    -- and passes it to EquipModule.ParseEquipParamValue (template id << 16 |
    -- distribution), as battle_module builds battle drops.
    local reward = {}
    for _, r in ipairs(granted) do
      if r.id == "gift_equip" and type(r.uids) == "table" and r.tid then
        for _ = 1, #r.uids do
          reward[#reward + 1] = { id = "drop_equip", count = 1, quantity = 1, args = r.args,
            params = tostring((r.tid << 16) | (r.dist or 1)) }
        end
      else
        reward[#reward + 1] = r
      end
    end
    print("[OFFLINE] OPEN_BOX " .. boxId .. " x" .. count .. " reward=" .. ser(reward))
    -- box_module's callback treats a missing result as a failed open and
    -- fires BOX.OPEN_RESULT(0, nil) (the "wish reset" path), so send 0.
    return okRes({ reward = reward }), sync
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
  -- achievement_module: claimed count is a 4-bit field per claimIndex in
  -- ACHIEVEMENT.cr; progress is a module function named after the id
  -- (BAG_ROOM, STAR_X, ...) or the ACHIEVEMENT.dr counter at recordKey.
  ["ACHIEVEMENT.CLAIM_REWARD"] = function(data)
    local id = tostring(tbl(data).id or "")
    local all = _ENV.ConfigMgr:GetAllAchievement() or {}
    local cfg = all[id]
    if type(cfg) ~= "table" then
      for _, c in pairs(all) do if type(c) == "table" and c.id == id then cfg = c end end
    end
    if type(cfg) ~= "table" then return failRes("ACHIEVEMENT.CLAIM_REWARD unknown " .. id) end
    local am = _ENV.AchievementModule
    if am:CanClaimReward(id, cfg) ~= 1 then return failRes("ACHIEVEMENT.CLAIM_REWARD " .. id .. " not reached") end
    local ci = math.floor(tonumber(cfg.claimIndex) or 0)
    local ach = moduleState("ACHIEVEMENT")
    ach.cr = tbl(ach.cr)
    local claimed = getBits(ach.cr, ci - 1, 4)
    local entries = rewardEntries(cfg["reward" .. (claimed + 1)])
    if #entries == 0 then return failRes("ACHIEVEMENT.CLAIM_REWARD " .. id .. " no reward") end
    local sync = { ACHIEVEMENT = ach }
    setBits(ach.cr, ci - 1, 4, claimed + 1)
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] ACHIEVEMENT.CLAIM_REWARD " .. id .. " #" .. (claimed + 1) .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,

  ["SHOP.BOX_WISH"] = function(data)
    local box = moduleState("BOX")
    box.we = math.floor(tonumber(tbl(data).equip) or 0)
    print("[OFFLINE] SHOP.BOX_WISH " .. box.we)
    return okRes({}), { BOX = box }
  end,

  -- The box result panel's decompose helper sends the pieces it just
  -- showed; match them to the pieces the last open created.
  ["SHOP.AUTO_DECOMPOSE"] = function(data)
    local eq = moduleState("EQUIP")
    eq.el = tbl(eq.el)
    local last, used, list = tbl(OFFLINE_LAST_BOX), {}, {}
    for _, it in ipairs(tbl(tbl(data).equip_list)) do
      local uid
      for _, v in ipairs({ it.args, it.id, it.params }) do
        local n = tonumber(v)
        if n and eq.el[tostring(math.floor(n))] and not used[tostring(math.floor(n))] then uid = tostring(math.floor(n)) break end
      end
      if not uid then
        for _, x in ipairs(last) do
          if not used[x.uid] and eq.el[x.uid] and (x.args == tostring(it.args) or it.args == nil) then uid = x.uid break end
        end
      end
      if uid then used[uid] = true list[#list + 1] = uid end
    end
    print("[OFFLINE] SHOP.AUTO_DECOMPOSE req=" .. ser(data) .. " uids=" .. ser(list))
    if #list == 0 then return okRes({ reward = {} }) end
    return RESPONSES["EQUIP.DECOMPOSE"]({ list = list })
  end,

  -- adventure_module: ADV.swl[stage_id] = sweep end time; the claim pays
  -- the client's own GetSweepRewardList for the stage.
  ["ADV.START_SWEEP"] = function(data)
    local stage = tostring(tbl(data).stage_id or "")
    local cfg = _ENV.ConfigMgr:GetStageConfig(stage)
    if type(cfg) ~= "table" then return failRes("ADV.START_SWEEP unknown " .. stage) end
    if _ENV.AdventureModule:CanSweep(stage) ~= 1 then return failRes("ADV.START_SWEEP " .. stage .. " not allowed") end
    local adv = moduleState("ADV")
    adv.swl = tbl(adv.swl)
    if adv.swl[stage] then return failRes("ADV.START_SWEEP " .. stage .. " already sweeping") end
    local sync = { ADV = adv }
    for _, c in ipairs(rewardEntries(seq(cfg.cost))) do
      if c.id == "energy" then
        local en = moduleState("ENERGY")
        regenEnergy(en)
        local e = tonumber(en.e) or 0
        if e < c.count then return failRes("ADV.START_SWEEP " .. stage .. " needs energy " .. c.count) end
        en.e = e - c.count
        if en.e < energyParams() and (tonumber(en.tst) or 0) <= 0 then en.tst = os.time() end
        sync.ENERGY = en
        bumpRecord(sync, 2, c.count)
      end
    end
    local now = os.time()
    pcall(function() now = tonumber(_ENV.TimeMgr:GetCurrentServerTime()) or now end)
    adv.swl[stage] = now + math.max(1, math.floor(tonumber(cfg.sweepTime) or 10800))
    print("[OFFLINE] ADV.START_SWEEP " .. stage .. " end=" .. adv.swl[stage])
    return okRes({}), sync
  end,

  ["ADV.COMPLETE_SWEEP"] = function(data)
    local stage = tostring(tbl(data).stage_id or "")
    local adv = moduleState("ADV")
    adv.swl = tbl(adv.swl)
    if not adv.swl[stage] then return failRes("ADV.COMPLETE_SWEEP " .. stage .. " not sweeping") end
    local now = os.time()
    pcall(function() now = tonumber(_ENV.TimeMgr:GetCurrentServerTime()) or now end)
    adv.swl[stage] = math.min(adv.swl[stage], now)
    return okRes({}), { ADV = adv }
  end,

  ["ADV.CLAIM_SWEEP_REWARD"] = function(data)
    local stage = tostring(tbl(data).stage_id or "")
    local adv = moduleState("ADV")
    adv.swl = tbl(adv.swl)
    if _ENV.AdventureModule:IsSweepComplete(stage) ~= 1 then return failRes("ADV.CLAIM_SWEEP_REWARD " .. stage .. " not complete") end
    local entries = {}
    for _, r in ipairs(tbl(_ENV.AdventureModule:GetSweepRewardList(stage))) do
      local n = math.floor(tonumber(r.count) or 0)
      if r.id ~= nil and n > 0 then entries[#entries + 1] = { id = r.id, count = n, args = r.args } end
    end
    local sync = { ADV = adv }
    adv.swl[stage] = nil
    bumpRecord(sync, 6, 1)
    local reward = grantRewards(entries, sync)
    print("[OFFLINE] ADV.CLAIM_SWEEP_REWARD " .. stage .. " reward=" .. ser(reward))
    return okRes({ reward = reward }), sync
  end,

  -- player_module: PLAYER.nst holds a 2-bit state per day (1 claimable,
  -- 2 claimed); rewards come from the newbie_signIn config row for the day.
  ["PLAYER.NEWBIE_SIGN"] = function(data)
    local day = math.floor(tonumber(tbl(data).day) or 0)
    local pl = moduleState("PLAYER")
    pl.nst = tbl(pl.nst)
    if day < 1 or day > 7 or getBits(pl.nst, day - 1, 2) ~= 1 then
      return failRes("PLAYER.NEWBIE_SIGN day " .. day .. " not claimable")
    end
    local row
    for _, r in pairs(_ENV.ConfigMgr:GetConfig("newbie_signIn") or {}) do
      if type(r) == "table" and tonumber(r.day) == day then row = r end
    end
    local entries = rewardEntries(row and row.reward)
    if #entries == 0 or not rewardsGrantable(entries) then return failRes("PLAYER.NEWBIE_SIGN day " .. day .. " reward unresolved") end
    local sync = { PLAYER = pl }
    setBits(pl.nst, day - 1, 2, 2)
    local reward = grantRewards(entries, sync)
    return okRes({ reward = reward }), sync
  end,

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
    bumpRecord(sync, 10, #list)
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
    local h = moduleState("HUNTER")
    h.dr = 0
    return okRes(), { PLAYER = p, SHOP = shop, HUNTER = h }
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

-- skin_view OnPressedWearSkin -> PLAYER.WEAR_SKIN. PLAYER.ws holds the worn
-- skin index in its low 8 bits (player_module GetSkinWearIndex, & 255) and
-- the random-skin switch in bit 8; PLAYER.sl is the owned-skin bitset
-- (GetSaveData: word ceil(i/32), bit (i-1)%32).
local function skinIndexOf(v)
  if type(v) == "number" then return math.floor(v) end
  if type(v) == "string" then
    local ok, c = pcall(function() return _ENV.ConfigMgr:GetSkinConfig(v) end)
    if ok and type(c) == "table" then return tonumber(c.index) end
    return tonumber(v)
  end
  return nil
end
local function skinOwned(pl, idx)
  if idx == 1 then return true end
  local w = tonumber(tbl(pl.sl)[(idx - 1) // 32 + 1]) or 0
  return (w >> ((idx - 1) % 32)) & 1 == 1
end
RESPONSES["PLAYER.WEAR_SKIN"] = function(data)
  print("[OFFLINE] PLAYER.WEAR_SKIN " .. ser(data))
  local idx
  if type(data) == "table" then
    for _, k in ipairs({ "index", "skin_index", "skin_id", "id", "skin" }) do
      idx = idx or skinIndexOf(data[k])
    end
    if not idx then for _, v in pairs(data) do idx = idx or skinIndexOf(v) end end
  else
    idx = skinIndexOf(data)
  end
  if not idx or idx < 1 or idx > 255 then return failRes("PLAYER.WEAR_SKIN bad skin " .. ser(data)) end
  local pl = moduleState("PLAYER")
  if not skinOwned(pl, idx) then return failRes("PLAYER.WEAR_SKIN skin " .. idx .. " not owned") end
  pl.ws = ((tonumber(pl.ws) or 0) & ~255) | idx
  -- SkinInfo.SendSkinChange (C#) reads ret_code and the skin id string from
  -- the response, then emits the skin-change event that refreshes the view.
  local sid = type(data) == "table" and type(data.id) == "string" and data.id or ("skin_" .. idx)
  return okRes({ id = sid, skin_id = sid, skin = sid, index = idx }), { PLAYER = pl }
end

-- PlayerModule:RequestSkinSetNew -> PLAYER.SET_NEW {id}; PLAYER.nl is the
-- bitset of skins whose "New!" badge was cleared (GetSkinNewState).
RESPONSES["PLAYER.SET_NEW"] = function(data)
  local idx = skinIndexOf(tbl(data).id)
  if not idx or idx < 1 or idx > 255 then return failRes("PLAYER.SET_NEW bad skin " .. ser(data)) end
  local pl = moduleState("PLAYER")
  local nl = tbl(pl.nl)
  local w = (idx - 1) // 32 + 1
  nl[w] = (tonumber(nl[w]) or 0) | (1 << ((idx - 1) % 32))
  pl.nl = nl
  return okRes(), { PLAYER = pl }
end

if MENU_BUILD then
  local CAP = 2147483647
  local AMOUNT = 99999999
  local Menu = {}
  _ENV.OfflineMenu = Menu
  local function cheats()
    local st = NetAgent.state or initState()
    st._cheat = type(st._cheat) == "table" and st._cheat or {}
    return st._cheat
  end
  local NAMES
  local function tip(msg)
    print("[OFFLINE-MENU] " .. msg)
    pcall(function() _ENV.GameHelper.ShowUITips(msg) end)
  end
  function Menu.AddResource(id, amount)
    amount = math.floor(tonumber(amount) or AMOUNT)
    local eco = moduleState("ECO")
    eco.d = tbl(eco.d)
    local before = tonumber(eco.d[id]) or 0
    eco.d[id] = math.min(CAP, before + amount)
    fireSync(NetAgent, { ECO = eco })
    tip("+" .. amount .. " " .. (NAMES[id] or id) .. ": " .. before .. " -> " .. eco.d[id])
  end
  function Menu.OpenPanel(name)
    -- The chest exchange panel indexes ActivityModule:GetChestConfig(), which
    -- is nil until the Chest module unlocks (MODULE_UNLOCK_STAGE.Chest).
    if tostring(name):find("activity/chest", 1, true) then
      local ok, open = pcall(function() return _ENV.ActivityModule:IsOpen() end)
      if not (ok and open) then
        local stage = "?"
        pcall(function() stage = tostring(_ENV.GameDef.MODULE_UNLOCK_STAGE.Chest) end)
        print("[OFFLINE-MENU] OpenPanel " .. tostring(name) .. " locked, unlock stage=" .. stage)
        tip("Shop trao đổi chưa mở: cần qua màn " .. stage)
        return
      end
    end
    -- GameHelper.OpenPanel is a raw lua_CFunction that reads a table at the
    -- top of the stack, so the call needs a (possibly empty) args table.
    for _, call in ipairs({
      function() return _ENV.GameHelper.OpenPanel(name, {}) end,
      function() return _ENV.GameHelper.OpenPanel(name, nil, {}) end,
    }) do
      local ok, err = pcall(call)
      print("[OFFLINE-MENU] OpenPanel " .. tostring(name) .. " ok=" .. tostring(ok) .. " " .. tostring(err))
      if ok then return end
    end
  end
  function Menu.UnlockSkins()
    local pl = moduleState("PLAYER")
    local sl = tbl(pl.sl)
    local n = 0
    for _, c in pairs(_ENV.ConfigMgr:GetConfig("skin") or {}) do
      local i = type(c) == "table" and tonumber(c.index)
      if i and i >= 1 then
        local w = (i - 1) // 32 + 1
        sl[w] = (tonumber(sl[w]) or 0) | (1 << ((i - 1) % 32))
        n = n + 1
      end
    end
    pl.sl = sl
    fireSync(NetAgent, { PLAYER = pl })
    pcall(function() _ENV.Event:FireEvent(NetAgent, "SKIN.CHANGED") end)
    tip("Đã mở khóa " .. n .. " skin")
  end

  -- One hit is built into the menu APK: tools/csv_onehit.py rewrites the
  -- enemy HP tables in assets/scg.ab (character, stage_room_property,
  -- stage_level) so every enemy spawns with 1 HP.
  -- Patching the table at runtime (loadCfgFile4CS + ReloadConfig) did not
  -- reach the C# battle, which keeps its own copy.
  NAMES = {
    coin = "Vàng", rmb = "Zeno", stone = "Quặng lục lam", gem = "Đá quý",
    core_weapon = "Lõi vũ khí", core_armor = "Lõi giáp", core_helmet = "Lõi mũ",
    core_shoes = "Lõi giày", core_ornament = "Lõi trang trí", core_disc = "Lõi đĩa ULT", capsule = "Viên nang XP", hb = "Xu kho báu Arch", ackp = "Điểm đổi rương sự kiện",
  }
  local PRESET = {
    { "+99999999 Vàng", "OfflineMenu.AddResource('coin', 99999999)" },
    { "+99999999 Zeno", "OfflineMenu.AddResource('rmb', 99999999)" },
    { "+99999999 Quặng lục lam", "OfflineMenu.AddResource('stone', 99999999)" },
    { "+99999999 Đá quý", "OfflineMenu.AddResource('gem', 99999999)" },
    { "+99999999 Lõi vũ khí", "OfflineMenu.AddResource('core_weapon', 99999999)" },
    { "+99999999 Lõi giáp", "OfflineMenu.AddResource('core_armor', 99999999)" },
    { "+99999999 Lõi mũ", "OfflineMenu.AddResource('core_helmet', 99999999)" },
    { "+99999999 Lõi giày", "OfflineMenu.AddResource('core_shoes', 99999999)" },
    { "+99999999 Lõi trang trí", "OfflineMenu.AddResource('core_ornament', 99999999)" },
    { "+99999999 Lõi đĩa ULT", "OfflineMenu.AddResource('core_disc', 99999999)" },
    { "+99999999 Viên nang XP (lên cấp)", "OfflineMenu.AddResource('capsule', 99999999)" },
    { "Mở khóa tất cả skin", "OfflineMenu.UnlockSkins()" },
    { "One hit: luôn bật (1 đòn chết quái)", "OfflineMenu.OneHitInfo()" },
    { "+99999999 Xu kho báu Arch", "OfflineMenu.AddResource('hb', 99999999)" },
    { "+99999999 Điểm đổi rương sự kiện", "OfflineMenu.AddResource('ackp', 99999999)" },
  }
  function Menu.OneHitInfo() tip("One hit luôn bật trong bản menu: quái và boss chỉ có 1 máu") end
  function Menu.Patch()
    -- The GM flag that enables the menu also turns on the developer error
    -- overlay (GMModule:IsOpenView); keep the menu, drop the overlay.
    local gmm = _ENV.GMModule
    if type(gmm) == "table" and not gmm.__offline_noview then
      gmm.IsOpenView = function() return false end
      gmm.__offline_noview = true
    end
    local gm = _ENV.GM
    if type(gm) ~= "table" then
      local ok = pcall(require, "module.gm")
      gm = ok and _ENV.GM or nil
    end
    if type(gm) == "table" and not gm.__offline_menu then
      gm.PresetCMD = function() return PRESET end
      gm.__offline_menu = true
    end
    if not Menu.__translated then
      Menu.__translated = pcall(Menu.TranslatePanel)
    end
  end
  -- The GM console (C# GMPanel prefab under GMManger.Instance) ships with
  -- Chinese button labels; it exists (inactive) from startup.
  local PANEL_VI = {
    { "Alt：补全代码", "Nhập lệnh Lua..." },
    { "保存为：", "Tên:" },
    { "保存指令", "Lưu lệnh" },
    { "上一条", "Lệnh trước" },
    { "下一条", "Lệnh sau" },
    { "执行", "Chạy" },
    { "删除指令", "Xoá lệnh" },
    { "关闭", "Đóng" },
    { "删除GM记录", "Xoá lịch sử" },
    { "查看报错", "Xem lỗi" },
    { "角色数据S/L", "Dữ liệu NV" },
    { "Enter text...", "Tên lệnh..." },
  }
  local function translate(text)
    for _, kv in ipairs(PANEL_VI) do
      local i = text:find(kv[1], 1, true)
      if i == 1 and kv[1]:sub(1, 3) == "Alt" then return kv[2] end
      if i then text = text:sub(1, i - 1) .. kv[2] .. text:sub(i + #kv[1]) end
    end
    return text
  end
  function Menu.TranslatePanel()
    local root = _ENV.Slua.GetClass("GMManger").Instance.GM_Panel.transform
    local function walk(tr)
      local t = tr.gameObject:GetComponent("Text")
      if t then
        local cur = tostring(t.text)
        local vi = translate(cur)
        if vi ~= cur then t.text = vi end
      end
      for i = 0, tr.childCount - 1 do walk(tr:GetChild(i)) end
    end
    walk(root)
  end
end

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

-- BoxItemIcon asks EquipModule:IsDecomposition about each box reward. For a
-- gift_equip or drop_equip entry its params parse to a nil quality and GetEquipQuality
-- throws, leaving the reward panel empty. A freshly granted piece is never
-- pre-marked for auto decompose, so answer false for gift_equip.
local function patchEquipDecompose()
  local em = _ENV.EquipModule
  if type(em) ~= "table" or em.__offline_dec or type(em.IsDecomposition) ~= "function" then return end
  local orig = em.IsDecomposition
  em.IsDecomposition = function(self, item, ...)
    -- drop_equip params are template id << 16 | distribution, which this
    -- reads as a base_value and gets a nil distribution.
    if type(item) == "table" and (item.id == "gift_equip" or item.id == "drop_equip") then return false end
    return orig(self, item, ...)
  end
  -- DropEquipmentItem (C#) calls ParseEquipParamValue through a
  -- RunGlobalTableFunction overload that may not pass the module as self, so
  -- the packed value lands in the first slot and the icon falls back to "?".
  -- Accept either calling convention.
  if type(em.ParseEquipParamValue) == "function" then
    em.ParseEquipParamValue = function(a, b)
      local v = math.tointeger(tonumber(type(a) == "table" and b or a))
      if not v then return { id = "0", quality = "0" } end
      local gd = _ENV.GameDef
      return { id = tostring(v >> 16), quality = gd:GetEquipQuality(v & 0xFFFF) }
    end
  end
  em.__offline_dec = true
end

-- Offline gear never goes to the mailbox: every piece is added to the bag.
-- BoxPanel still shows COMMON.equip_mail ("inventory full, stored in the
-- mailbox") unless a reward is a "myequip" entry, which the box reward icons
-- cannot draw, so reword that tip instead.
-- Menu build: every feature gated by a stage requirement opens at once.
local function unlockAllModules()
  local gd = _ENV.GameDef
  if not MENU_BUILD or type(gd) ~= "table" or gd.__offline_unlock then return end
  if type(gd.MODULE_UNLOCK_STAGE) == "table" then
    for k in pairs(gd.MODULE_UNLOCK_STAGE) do gd.MODULE_UNLOCK_STAGE[k] = 0 end
  end
  if tonumber(gd.HEROIC_UNLOCK_STAGE) then gd.HEROIC_UNLOCK_STAGE = 0 end
  -- World entries (FateEntry, FrontlineEntry) compare the stage record with
  -- these indexes; the record is never below 0.
  for _, k in ipairs({ "FATE_STAGE_INDEX", "FRONT_LINE_STAGE_INDEX" }) do
    if tonumber(gd[k]) then gd[k] = -1 end
  end
  local am = _ENV.AdventureModule
  if type(am) == "table" and type(am.CanEnterFate) == "function" then
    am.CanEnterFate = function() return 1 end
  end
  -- CheckCondition components (the World tab's "complete Mission 2-1" lock)
  -- ask condition_mgr's passStage, which compares AdventureModule:GetRecord().
  local cnd = _ENV.ConditionMgr
  if type(cnd) == "table" and type(cnd.CheckCondition) == "function" and type(cnd.GetValue) == "function" then
    local check, value = cnd.CheckCondition, cnd.GetValue
    cnd.CheckCondition = function(self, t, p, ...)
      if t == "passStage" then return 1 end
      return check(self, t, p, ...)
    end
    cnd.GetValue = function(self, t, p, ...)
      if t == "passStage" then return 1, 1 end
      return value(self, t, p, ...)
    end
  end
  -- item UseCondition {id = "passStage", param = N} (pay_pet_D: Mission 5)
  local cm = _ENV.ConfigMgr
  for _, c in pairs(cm and cm:GetConfig("item") or {}) do
    if type(c) == "table" and type(c.UseCondition) == "table" then
      local keep = {}
      for _, u in ipairs(c.UseCondition) do
        if not (type(u) == "table" and u.id == "passStage") then keep[#keep + 1] = u end
      end
      c.UseCondition = keep
    end
  end
  gd.__offline_unlock = true
end

local function patchLang()
  local lang = _ENV.LANG
  if type(lang) ~= "table" or lang.__offline_lang or type(lang.GetTextData) ~= "function" then return end
  local orig = lang.GetTextData
  lang.GetTextData = function(a, b, c, ...)
    local group, key = a, b
    if a == lang then group, key = b, c end
    if group == "COMMON" and key == "equip_mail" then
      return "Your new gear has been added to your inventory"
    end
    return orig(a, b, c, ...)
  end
  lang.__offline_lang = true
end

-- BindAccountOpenChecker (C#) opens the "Link with" Google/Facebook panel on
-- every main-scene entry for guest logins unless the local int
-- stop_bind_open_checker is 1. Offline there is nothing to link, and the panel
-- can cover the target of an active guide step, leaving the guide stuck.
local function stopBindPanel()
  if NetAgent.__offline_nobind then return end
  local ok = pcall(function() _ENV.GameHelper.SetLocalInt("stop_bind_open_checker", 1) end)
  NetAgent.__offline_nobind = ok
end

function NetAgent:SendRequest(group, name, data, cb)
  print("[OFFLINE] SendRequest group=" .. tostring(group) .. " name=" .. tostring(name))
  patchCustomData()
  patchEquipDecompose()
  unlockAllModules()
  patchLang()
  stopBindPanel()
  if MENU_BUILD then pcall(_ENV.OfflineMenu.Patch) end
  local res, _, sync = offlineResponse(group, name, data)
  local prevs = commitSync(sync)
  local agent = self
  -- the caller publishes SERVER_RESPONSE from this callback and only then
  -- waits on it, so delivering inline drops the message ("Wait nil But
  -- Receive SERVER_RESPONSE"). Defer to the next tick.
  self.pending[#self.pending + 1] = {
    res = res, tag = tostring(group) .. "." .. tostring(name),
    cb = function(r) fireSync(agent, sync, prevs); if cb then cb(r) end end,
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
  local prevs = commitSync(sync)
  local agent = self
  self.pending[#self.pending + 1] = {
    tag = tostring(group) .. "." .. tostring(name) .. "#cs",
    res = res,
    cb = function(r)
      fireSync(agent, sync, prevs)
      if agent.cs_callback then agent.cs_callback(session, r)
      else print("[OFFLINE] no cs_callback for session " .. session) end
    end,
  }
  return session
end


function NetAgent:Login(...)
  -- purchase_mgr.OnPressedItem takes the in-game route (ECO_PURCHASE) when
  -- CanBuyProductByMoney says yes; offline every real-money pack does.
  local pm = _ENV.PurchaseModule
  if type(pm) == "table" and not pm.__offline_free then
    pm.CanBuyProductByMoney = function(_, sku)
      local cfg = _ENV.ConfigMgr:GetSKUConfig(sku)
      return type(cfg) == "table" and cfg.model == "money" and 1 or 0
    end
    pm.__offline_free = true
  end
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
if DEV_EVAL then
  _ENV.OfflineDev = { ser = ser, RESPONSES = RESPONSES, moduleState = moduleState }
end
return NetAgent
