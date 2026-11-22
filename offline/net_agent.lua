-- offline net_agent v5: introspect GameDef at runtime, return real SUCCESS
print("[OFFLINE] net_agent source stub v5")
local NetAgent = {}
_ENV.NetAgent = NetAgent
NetAgent.SERVER_LIST = {}
NetAgent.logined = false
NetAgent.logining = false
NetAgent.proto_handle_list = {}
NetAgent.send_callback_list = {}

function NetAgent:Init(...) print("[OFFLINE] NetAgent:Init") end
function NetAgent:IsServerList() return 0 end
function NetAgent:IsServerUrlLoaded() return 1 end
function NetAgent:GetServerList() return {} end
function NetAgent:IsConnecting() return 0 end
function NetAgent:GetNetworkDelayDisplay() return "0" end
function NetAgent:RequestServerRoute(...) end
function NetAgent:Connect(...) end
function NetAgent:Update(...) end
function NetAgent:Reset(...) end
function NetAgent:AddConnectingFilterProto(...) end
function NetAgent:ClearProtoCallback(...) end
function NetAgent:RegServerRequestHandler(...) end
function NetAgent:RegistRequestCallback(...) end
function NetAgent:sendSproto(...) end
function NetAgent:ApplyDisconnect(...) end
function NetAgent:OnServerDisconnect(...) end

function NetAgent:SendRequest(group, name, data, cb)
  print("[OFFLINE] SendRequest " .. tostring(group) .. "." .. tostring(name))
  local res = {}
  if cb then cb(res) end
  return res
end
function NetAgent:SendRequest4CS(...) return {} end

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

  local role = ""
  local ok, packed = pcall(function()
    if _ENV.Compressor and _ENV.Compressor.Compress then
      return _ENV.Compressor:Compress("{}")
    end
    return ""
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
