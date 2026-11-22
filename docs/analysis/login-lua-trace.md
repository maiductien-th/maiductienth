# Swordash login trace — Lua layer (read-only, corrected)

Static analysis only, of `work/base.apk`, `in/apk/lib/arm64-v8a/libil2cpp.so` and the
decoded AssetBundle Lua chunks. No hooks, no patching, no packaging, no live login
request. This revision supersedes the previous Lua report, which labelled the
Lua call edges as inferred from constant tables. They are now decoded.

## 1. Correction to the previous report

The previous report claimed the packaged Lua could not be decoded because "SLua remaps
the Lua 5.3 opcode table", citing a strange opcode histogram. That reasoning was not
sound, and one of its two premises was wrong.

**My decoder was wrong first.** The chunk header is:

```
1b4c 6175 5300 1993 0d0a1a0a 04 04 04 08 08
 .Lua  S  fmt  LUAC_DATA     ^  ^  ^  ^  ^
                       sizeof(int)=4  |  |  sizeof(lua_Number)=8
                        sizeof(size_t)=4  sizeof(lua_Integer)=8
                          sizeof(Instruction)=4
```

`sizeof(size_t)` is **4**, not 8. My parser assumed 8, so every string length after the
first was read at the wrong width and the instruction stream was misaligned. That alone
produced the garbage histogram. With `size_t=4` every chunk parses byte-exact to EOF
(`parsed == len(file)` for all 171 chunks), which is what rules out a residual
format/alignment error.

**The remap is nevertheless real**, but it is established from structural invariants,
not from a histogram. See §2.

A second claim in the previous report should also be dropped: the opcode-name strings
visible in `libslua.so` (`MOVE`, `BAND`, `SETTABLE`, `JMP`, ...) appear in linker string
order, not in `luaP_opnames` array order, so they are not evidence of either a stock or
a remapped table.

## 2. Recovering the opcode mapping

The instruction **bit layout is stock** Lua 5.3 (`op = i & 0x3F`, `A = (i>>6)&0xFF`,
`C = (i>>14)&0x1FF`, `B = (i>>23)&0x1FF`, `Bx = (i>>14)&0x3FFFF`). The alternative
layout (`op` in the high 6 bits) fails every invariant below. The **opcode numbering is
permuted**.

Corpus: 3,207 protos across 171 decoded chunks.

Invariants used, each of which holds for 100% of the corpus:

| raw | stock | evidence |
|---|---|---|
| 24 | `RETURN`   | last instruction of all 3,207 protos |
| 30 | `CLOSURE`  | per-proto occurrence count == that proto's nested-proto count, in every proto; `Bx < nprotos` always |
| 41 | `TFORCALL` | always immediately followed by raw 2 |
| 2  | `TFORLOOP` | counts equal to raw 41 (652/652); valid `sBx` |
| 36 | `JMP`      | exactly five opcodes are *always* followed by it |
| 0  | `TAILCALL` | always followed by `RETURN`; `C == 0` always |
| 25 | `LOADK`    | `Bx < len(k)` always |
| 27 | `GETTABUP` | `B < nupvalues` always; `B == 0` (`_ENV`) 83%; `C` is a string-constant RK 96% |
| 40 | `FORPREP`  | always preceded by `LOADK`; forward `sBx` |
| 34 | `FORLOOP`  | same count as `FORPREP` (231/231); backward `sBx` |
| 19 | `TEST`     | always→`JMP`; `B == 0` always; `C ∈ {0,1}` |
| 38 | `TESTSET`  | always→`JMP`; `C ∈ {0,1}`; `B` a register |
| 23 | `EQ`       | always→`JMP`; `A ∈ {0,1}` |
| 7, 8 | `LT`, `LE` | always→`JMP`; `A ∈ {0,1}` |
| 6  | `CALL`     | `B,C < 8` always; `C == 1` (statement call) 35% |
| 32 | `MOVE`     | `C == 0` always; most common predecessor of `CALL` |
| 5  | `GETUPVAL` | `B < nupvalues` always; `C == 0` |
| 46 | `GETTABLE` | `C` string-RK 82%; `B` a register |
| 28 | `SELF`     | `C` string-RK 100% |
| 35 | `SETTABLE` | `B` is RK 78% |
| 42 | `NEWTABLE` | `B,C` small; followed by `SETTABLE` |
| 29 | `CONCAT`   | `B < C`, both plain registers, never RK |
| 9  | `SETLIST`  | `C == 1` 99%; usually preceded by `LOADK` |
| 15 | `VARARG`   | `B == C == 0`; followed by `CALL` |
| 20 | `LOADNIL`  | `B == 0` 87%; `C == 0` |
| 14 | `SETTABUP` | `A` bounded by upvalue count (max 11), `B` string-RK |
| 3  | `SETUPVAL` | confirmed at a known source line (see below) |
| 16 | `LOADBOOL` | `C ∈ {0,1}`, frequently preceded by `JMP` |

Confidence: `RETURN`, `CLOSURE`, `TFORCALL`/`TFORLOOP`, `JMP`, `TAILCALL`, `LOADK`,
`GETTABUP`, `CALL`, `MOVE`, `SELF`, `GETTABLE`, `SETTABLE`, `GETUPVAL`, `NEWTABLE`,
`SETLIST`, `CONCAT`, `VARARG`, `LOADNIL`, `FORPREP`/`FORLOOP` are **high** — each rests
on a 100% structural invariant plus a coherent decode. `LT` vs `LE` (raw 7 vs 8) is
**low**: both satisfy every invariant identically and are distinguished only by relative
frequency; they are interchangeable without affecting any conclusion in this report.
`SETTABUP` and `LOADBOOL` are **medium**.

The arithmetic/bitwise opcodes were not needed for call-graph recovery and are mostly
unassigned; three opcodes (raw 10, 22, 45) never appear in this corpus. Where an
unmapped opcode appears in a trace below it is printed as `opNN`. Context identifies
raw 17 as `ADD`, 18 as `MUL` and 31 as `SUB` (`os.clock()*1000`, `sending + 1`,
elapsed-time subtraction) — **medium** confidence, and not load-bearing.

Two independent validations:

1. Applying the mapping, the corpus opcode frequency ranking becomes
   `LOADK 11.5%, CALL 10.4%, GETTABUP 9.2%, MOVE 8.7%, SETTABLE 8.5%, GETTABLE 8.0%,
   JMP 7.3%, RETURN 7.2%, SELF 4.7%` — the same shape as a reference corpus compiled
   with stock `luac5.3` on this machine. Under the unmapped reading the top entries were
   `NOT`, `EXTRAARG`, `UNM`, `SHR`, which no real Lua program produces.
2. The decoded instructions agree with the chunks' own debug line numbers and local/upvalue
   name tables, and read as coherent Lua. Example confirming `SETUPVAL` (raw 3):
   `login_mgr` line 224 is `LOADK R4 := 'guest'` then `raw3 A=4 B=2` with
   `upvals = ['self','_ENV','login_platform']` — i.e. `login_platform = 'guest'`.

## 3. Method names are read, not guessed

Every function name below is taken from the module table assignment in the chunk's main
body (`SETTABLE R0["<name>"] := <closure>` paired with the closure's own
`linedefined`/`lastlinedefined`), not inferred from nearby constants. Confidence: **high**.

`net_agent` (`@net/net_agent.lua`), 29 methods, including:

```
RequestServerRoute   97-105     Connect              293-323
_RequestServerRoute 107-257     Login                355-369
ProtoCallback       497-506     _Login               371-485
CSProtoCallback     508-513     SendRequest          516-538
RegistRequestCallback 540-542   SendRequest4CS       544-553
sendSproto          556-583     OnReceveServerRequest  592-612
                                OnReceveServerResponse 614-665
```

This corrects a naming error in the previous report, which treated the function at
lines 516-538 as `sendSproto`. It is `SendRequest`; `sendSproto` is at 556-583.

`login_mgr` (`@login/login_mgr.lua`), 25 methods, including
`onLoginSuccess 115-207`, `Login 209-253`, `GetLoginErrMsg 255-278`, `Relogin 334-419`.

`sproto_helper`, including `_websocketConnect 115-134`, `Connect 136-143`,
`Disconnect 145-159`, `SendSprotoRequest 174-185`, `_sendRequestPackage 187-209`,
`sendPackage 211-232`.

## 4. The game-server login request, decoded

**`NetAgent.Login` (355-369)** is a thin wrapper. It sets `self.logining = 1` (pc0),
times the call, and at pc25-28 performs `self:_Login(...)`:

```
25 SELF  R5 := R0; R4 := R0["_Login"]
28 CALL  R4(3 args) -> 1
44 SETTABLE R0["logining"] := 0
45 RETURN return 1 from R4          -- returns _Login's result unchanged
```

**`NetAgent._Login` (371-485)** is the game-server login request method. Decoded edges:

```
 1 SELF  R4 := R0["Connect"]          -- self:Connect(messager)
 4 CALL  R4(3 args) -> 2
 7 print 'Connect Server Failed!'     -- failure path -> LOGIN_RESULT.*
37 SELF  R6 := R0["sendSproto"]       -- self:sendSproto('HELLO', ...)
38 LOADK R8 := 'HELLO'
48 CALL  R6(4 args)
49 SELF  R6 := R1["Wait"]             -- messager:Wait(...)
51 CALL  R6(2 args) -> 1
53 GETTABUP _UP1["PROTO_CODE"]        -- protocol-version / auth checks
164 SELF R17 := R17["Compress"]       -- Compressor:Compress(payload)
169 SELF R18 := R0; R17 := R0["sendSproto"]
170 LOADK R19 := 'LOGIN'              -- self:sendSproto('LOGIN', payload, ...)
173 CALL R17(4 args)
174 SELF R18 := R1; R17 := R1["Wait"]
175 LOADK R19 := 'LOGIN_RESULT'       -- messager:Wait('LOGIN_RESULT')
176 CALL R17(2 args) -> 1
178 GETTABUP _UP1["LOGIN_RESULT"]     -- compare returned code
190 GETTABLE R18 := R17["session"]
191 SETTABLE R0["player_session"] := R18
```

So the request is `sendSproto('LOGIN', <compressed payload>)` preceded by a `HELLO`
handshake, and the reply is awaited synchronously via the messager coroutine on the
`'LOGIN_RESULT'` event. Confidence: **high** (all edges decoded, names from §3).

## 5. Connection to the login-success handler, decoded

`LoginMgr.Login` (209-253) is a wrapper that runs its body as a coroutine:

```
0 GETTABUP R2 := _UP0["StartMessager"]
1 CLOSURE  R3 := proto#0              -- the body, lines 210-252
2 CALL     R2(1 args)
```

Inside that body (lines 210-252, upvalues `['self','_ENV','login_platform']`):

```
39 GETTABUP R4 := _UP0["login_agent"]
40 SELF     R4 := R4["GetLoginToken"]   -- provider token (see §6)
42 CALL     R4(2 args) -> 2
63 NEWTABLE R6                          -- the LOGIN payload
64 SETTABLE R6["publish_platform"] := R1
66 SETTABLE R6["login_platform"]   := R7
67 SETTABLE R6["login_token"]      := R4
68 SETTABLE R6["oauth_token"]      := R5
69 GETTABUP R7 := _UP1["NetAgent"]
70 SELF     R8 := R7; R7 := R7["Login"] -- NetAgent:Login(self, payload)
73 CALL     R7(3 args) -> 1
74 GETTABLE R8 := R7["login_result"]
75 GETTABUP R9 := _UP1["GameDef"]
77 GETTABLE R9 := R9["SUCCESS"]         -- GameDef.LOGIN_RESULT.SUCCESS
78 EQ       R8 == R9
79 JMP      -> pc87                     -- not success -> failure path
80 GETUPVAL R9 := _UP0                  -- self
81 SELF     R10 := R9; R9 := R9["onLoginSuccess"]
85 CALL     R9(4 args) -> 0             -- self:onLoginSuccess(self, platform, ret)
...
87 GETTABLE R9 := R7["ret_code"]        -- failure branch
90 GETTABLE R10 := R10["OFFLINE"]
97 SELF     R9 := R9["GetLoginErrMsg"]
105 LOADK   R13 := 'LOGIN.FAILED'
108 CALL    R10(5 args)
```

This is the connection the earlier report could not establish: the success handler is
called **only** on `login_result == GameDef.LOGIN_RESULT.SUCCESS`, directly from the
return value of `NetAgent:Login`. Confidence: **high**.

**`LoginMgr.onLoginSuccess` (115-207)** then writes the Lua-side logged-in state:

```
  0 SETTABLE R0["IS_LOGGED_IN"] := 1
  4 CALL     global('AUTO_LOGIN', 1)
  6 SETTABLE R0["user_id"]      := R3["uid"]
 12 SETTABLE R0["login_token"]  := R3["oid"]
 16 SETTABLE R0["gate_id"]      := R3["gid"]
 18 SETTABLE R0["session"]      := R3["session"]
 19-40  GameHelper.SetLocalInt/SetLocalString  (_last_login_time, _last_user_id,
                                                _last_login_platform, _last_login_token)
 62 TimeMgr:SyncServerTimeZone(R3["server_timezone"])
 73 Compressor:Decompress(R3["role_data"])
 78 Event:FireEvent(self,'LOAD_SERVER_ROLE_DATA', role_data)
 84 Event:FireEvent(self,'LOAD_ROLE_DATA_OVER', publish_platform, user_id)
106 Bootstrap.InitClientModule(...)
150 Event:FireEvent(self,'LOGIN.SUCCESS', publish_platform, user_id, new_day)
```

Confidence: **high**.

## 6. Three layers, kept separate

### 6a. Provider authentication (C# SDK side)

Unchanged from the corrected native report. `AccountMgr.Login` RVA `0x17C2F78`
dispatches to the concrete `IAccount` implementation; `FirebaseAccount.Login`
`0x17C63D8` → `FirebaseAuth.SignInWithCredentialAsync` `0x1AEC698`;
`GoogleAccount.Login` `0x17C7058` → `GoogleSignIn.SignIn` `0x1939610`;
`FacebookAccount.Login` `0x17C4DC4`. Provider state is the `eLoginState` at account
object `+0x30`, written only by `FirebaseAccount.SetLoginState` `0x17C6688`
(`str w20,[x19,#0x30]` @ `0x17C6700`, `w20` from the saved `state` argument).
Enum value 3 (`LOGIN_COMPLETE`) is written on error paths too (e.g. `0x17C6634` and
`0x17C7268`, both immediately after `MyLog.Error`), so it is not a success signal.

The Lua side enters this layer through `GameHelper.LoginAccount`. Decoded from the
`google` login agent's `GetLoginToken` (lines 18-57):

```
29 GETTABUP R4 := _UP0["GameHelper"]
30 GETTABLE R4 := R4["LoginAccount"]
32 CALL     R4(1 args)
34 GETTABUP R6 := _UP0["World"]; SELF R6["RegistUpdate"]
39 SELF     R6 := R1["Wait"]
40 LOADK    'LOGIN_TOKEN_RESULT'
41 CALL     R6(2 args)
```

`GameHelper.LoginAccount` is the C#-exported binding whose IL2CPP thunk is
`Lua_GameHelper.LoginAccount_s` (`0x1720E30`, `Method$Lua_GameHelper.LoginAccount_s()`
in `script.json`), reaching `GameHelper.LoginAccount` → `AccountMgr.Login`.
Confidence: **high** for the Lua→`GameHelper.LoginAccount` edge (decoded);
**medium** for the `Lua_GameHelper.LoginAccount_s` → `AccountMgr.Login` continuation,
which rests on the name binding and the native dump rather than a decoded call.

### 6b. Game-server request / response (Lua + WebSocket)

Decoded transport chain:

```
NetAgent:Connect (293-323)
    upvalue _UP0 = SprotoHelper
    pc 9  self:RequestServerRoute(messager)        -- gateway lookup if no server_params
    pc 35 SprotoHelper:Connect(messager, host, port, cb, cb)
    pc 42 messager:Wait('CONNECT_RESULT')

SprotoHelper:Connect (136-143) -> _websocketConnect (115-134)
    pc 22 GETTABUP WSHelper ; GETTABLE "Connect" ; CALL R8(2 args)

NetAgent:sendSproto (556-583)
    pc 17 SprotoHelper:SendSprotoRequest(name, args)
    pc 32 self.send_callback_list[session] = callback
    pc 38 self.session_proto_info[session] = {name=..., args=...}

SprotoHelper:SendSprotoRequest (174-185) -> _sendRequestPackage (187-209)
                                         -> sendPackage (211-232)
    pc  2 string.pack('>s2', ...)
    pc 14 GETTABUP WSHelper ; GETTABLE "Send" ; CALL R3(1 args)

SprotoHelper:Disconnect (145-159)
    pc 12 GETTABUP WSHelper ; GETTABLE "Close" ; CALL
```

`WSHelper` is the C# `[CustomLuaClass]` static: `WSHelper.Connect` `0x19865D0`,
`WSHelper.Send` `0x198679C`, `WSHelper.Close` `0x1986898`, bound through
`Lua_WSHelper.Connect_s` `0x17260C8` and `Lua_WSHelper.Send_s` `0x1726238`.

**This closes the edge the previous report left open.** `net_agent` reaches
`WSHelper`/`WSConnection` indirectly, via `sproto_helper`, which is why a direct
`net_agent`→`WSHelper` search found nothing. Confidence: **high** for every Lua edge
(decoded) and for the `WSHelper` global being the C# binding (name + `[CustomLuaClass]`
declaration in the dump).

Response side, `NetAgent:OnReceveServerResponse` (614-665), decoded:

```
  0 R3 := self.session_proto_info[session]
  3 self.session_proto_info[session] = nil
  8 PROTO_CODE.ERR_SAVE_PLAYER_DATA -> Event:FireEvent(self,'SAVE_ROLE_ERROR'); return
 18 PROTO_CODE.OFFLINE  -> network_delay, Event:FireEvent('REFRESH_NETWORK_DELAY')
 35 Compressor:Decompress(response.sync_list)
 50 Event:FireEvent(self,'ON_RECEVE_SERVER_RESPONSE')
 90 Event:FireEvent(self,'SYNC_SERVER_DATA', sync_list)
 96 R7 := self.send_callback_list[session]
 99 self.send_callback_list[session] = nil
102 SELF R8 := R0["ProtoCallback"]
107 CALL R8(5 args)
```

The `'LOGIN_RESULT'` that `_Login` waits on is delivered through this dispatcher, keyed
by the session id recorded in `sendSproto`. Confidence: **high**.

### 6c. Game-entry state (C# side)

Unchanged and still the only confirmed native flag write:

```
mov  w20, #1           @ 0x172CCF0
strb w20, [x19,#0x81]  @ 0x172CD0C      ; x19 = LoginManager instance
```

in `LoginManager.OnLoginSuccess` `0x172CB24`, where `+0x81` is `LoginManager.is_logined`.
It is gated on `is_auto`, read at `0x172CCA0`: when `is_auto == 0` the method calls
`EnterGame` `0x172CF54` at `0x172CD18` and never reaches the `is_logined` write; the two
branches are mutually exclusive. This is a different field on a different object from
the provider `eLoginState` at `+0x30` in §6a.

## 7. The native callback binding, resolved

A previous revision of this report claimed the C# `LoginManager.OnLoginSuccess`
binding "cannot be resolved statically from this build", on the grounds that the
metadata-usage slots feeding `RunGlobalTableFunction` are zero in the file. **That
claim was wrong and is withdrawn.** A zero slot is not an unresolvable slot: these
slots carry `R_AARCH64_RELATIVE` relocations (type `1027`), and the relocation addend
names the target. The dynamic loader writes the value; the value is fully determined by
the file.

Reproduce with `tools/resolve_slots.py <start_rva> <end_rva>`, which joins capstone
disassembly to `.rela.dyn` addends and the Il2CppDumper `script.json` tables
(`ScriptString`, `ScriptMetadata`, `ScriptMetadataMethod`, `ScriptMethod`).

### 7a. Registration: Lua event name -> C# method

`LoginManager.Start` (`0x17298B4`) builds an `SLua.CSCallback` over a
`LoginManager` method and hands it to
`LuaManager.RegistLuaEvent(string event_name, CSCallback cb)` (`0x1729E28`). Six
registrations, each an `adrp`+`ldr` of a relocated slot:

| Lua event name | slot (name) | C# method | method slot | RVA |
|---|---|---|---|---|
| `LOGIN.SUCCESS` | `0x3540850` | `LoginManager.OnLoginSuccess` | `0x3540810` | `0x172CB24` |
| `LOGIN.FAILED` | `0x3540840` | `LoginManager.OnLoginFailed` | `0x3540808` | `0x172D978` |
| `SERVER_DISCONNECT` | `0x3540848` | `LoginManager.OnLoginFailed` | `0x3540808` | `0x172D978` |
| `CHANGE_TARGET_SERVER` | `0x3540858` | `LoginManager.OnChangeServer` | `0x35407F8` | `0x172D330` |
| `DISPLAY_SERVER_LIST` | `0x3540828` | `LoginManager.OnDisplayServerList` | `0x3540800` | `0x172D344` |
| `ANNOUNCEMENT.UPDATE` | `0x3540860` | `LoginManager.OnOpenAnncouncementPanel` | `0x3540818` | `0x172D3B8` |

The `LOGIN.SUCCESS` registration in full:

```asm
0x17299D4: ldr x22, [x22, #0x7e8]   ; [0x35407E8] = SLua.CSCallback_TypeInfo
0x17299D8: ldr x21, [x21, #0x810]   ; [0x3540810] = Method$LoginManager.OnLoginSuccess()
0x17299E4: bl  #0x1729D80           ; LuaManager.get_Instance
0x17299F8: ldr x2, [x21]            ; arg2 = OnLoginSuccess method pointer
0x17299FC: mov x1, x19              ; arg1 = this (LoginManager)
0x1729A08: bl  #0x16F76EC           ; SLua.CSCallback..ctor
0x1729A14: ldr x8, [x8, #0x850]     ; [0x3540850] = "LOGIN.SUCCESS"
0x1729A24: ldr x1, [x8]             ; arg1 = event name
0x1729A20: mov x2, x21              ; arg2 = the CSCallback
0x1729A2C: bl  #0x1729E28           ; LuaManager.RegistLuaEvent
```

`SERVER_DISCONNECT` reuses `x23` from the `LOGIN.FAILED` registration — `x23` is loaded
at `0x1729A28` and not rewritten before `0x1729A88`, so both events map to
`OnLoginFailed`.

### 7b. This closes the Lua-to-native edge

§5 decoded Lua `login_mgr.onLoginSuccess` firing `"LOGIN.SUCCESS"`, and that string is
present in the chunk's constant pool (`login_mgr` line 182; `LOGIN.FAILED` at 226).
§7a shows `"LOGIN.SUCCESS"` is the key C# `LoginManager.OnLoginSuccess` is registered
under. The two halves meet at the event name:

```
Lua login_mgr.onLoginSuccess  -- fires "LOGIN.SUCCESS"
      -> LuaManager event registry
      -> C# LoginManager.OnLoginSuccess (0x172CB24)
      -> is_auto gate -> EnterGame (0x172CF54)  OR  is_logined = 1 (0x172CD0C)
```

The decoded Lua handler and the native handler are still **different functions** with
similar names; what is now established is the registry edge between them.

### 7c. The `RunGlobalTableFunction` arguments, resolved

Previously called unresolved. Each call's string arguments resolve through the same
relocations — and one of them corrects a wrong guess:

| Caller | RVA of call | table_name | name |
|---|---|---|---|
| `LoginManager.StartLogin` | `0x172AF0C` | `AnnouncementMgr` | `IsAutoDisplayAnnouncement` |
| `LoginManager.Login` | `0x172B744` | `LoginMgr` | `Login` |
| `LoginManager.OnLoginSuccess` | `0x172CDB4` | `RemoteModuleMgr` | `GetLastLifeTime` |

`LoginManager.Login` -> Lua `LoginMgr.Login` is now a **decoded argument**, not an
inference from the global's name. The third row corrects the earlier guess that this
call targeted the `LoginMgr` table: it does not. It calls
`RemoteModuleMgr.GetLastLifeTime`, which is unrelated to the login handoff.

## 8. Remaining uncertainty

- **The C#->Lua request callback bridge is decoded on the Lua side only.**
  `NetAgent:RegistRequestCallback (540-542)` is a one-line setter
  (`self.cs_callback = cb`); `NetAgent:SendRequest4CS (544-553)` allocates a
  `cs_session` and calls `self:SendRequest(...)` with a closure that tail-calls
  `self:CSProtoCallback`; `CSProtoCallback (508-513)` does
  `scall(self.cs_callback, ...)`. The matching native functions are
  `LuaManager.RegistRequestCallback` `0x172C67C` and `LuaManager.SendRequest`
  `0x172D68C`. The pairing is by name and signature shape — **medium** confidence.
  The slot-resolution method of §7 was not applied to this bridge.
- **`LT` vs `LE`** (raw 7 vs 8) is an arbitrary assignment, as noted in §2. No
  conclusion here depends on it.
- **Whether the provider SDK calls perform network I/O internally** was not
  investigated; it would require tracing into the Firebase/Google/Facebook native
  libraries. **Unknown.**
- **119 of the 290 extracted chunks did not parse** (171 parsed cleanly). The parse
  failures were not investigated; none of the chunks relevant to this trace is among
  them. The Lua call-graph statements are therefore lower bounds over the parsed set.
- Static `BL`/`B` scans of `libil2cpp.so` remain lower bounds: the binary has roughly
  72,550 `BLR` and 19,265 `BR` sites that a direct-branch scan cannot see, so no
  "only caller" or "only write site" claim is made anywhere in this report.
- No runtime trace was performed and no live login request was made; every statement
  above is static.

## 9. Change footprint

Analysis was read-only against the extracted APK: no hooks, no patching, no repacking,
no signing and no live server request. This repository change adds documentation under
`docs/analysis/` and one analysis helper, `tools/resolve_slots.py`. No game binary,
build script or manifest was modified.
