-- offline compressor: same LibDeflate path as the game, but tolerant of
-- uncompressed input so a synthesized role_data can be shipped as plain text.
local LibDeflate = require "lib.LibDeflate"
local Compressor = {}
_ENV.Compressor = Compressor

function Compressor:Compress(str)
  if type(str) ~= "string" then return str end
  local gd = _ENV.GameDef
  if gd and gd.IS_COMPRESS == 1 then
    local ok, out = pcall(function() return LibDeflate:CompressDeflate(str) end)
    if ok and type(out) == "string" then return out end
  end
  return str
end

function Compressor:Decompress(str)
  if type(str) ~= "string" then return str end
  local ok, out = pcall(function() return LibDeflate:DecompressDeflate(str) end)
  if ok and type(out) == "string" and #out > 0 then
    return out
  end
  return str
end

return Compressor
