# Login-service native trace — corrected (read-only)

Binary: `in/apk/lib/arm64-v8a/libil2cpp.so` (arm64-v8a). RVA = file offset + 0x4000.
Disassembly: capstone ARM64 over the real `.so` at the dump's RVAs. Field names and offsets from
`out/recovered/dump.cs`. Nothing was built, patched, committed or pushed.

## Method and its limits

Call edges below come from a scan of every direct branch in the image: `BL` (opcode 0x25) and `B`
(opcode 0x05, i.e. tail calls). That scan **cannot** see indirect edges, and this image has
**72,550 `BLR`** and **19,265 `BR`** sites. Virtual/interface dispatch, delegate invocation and Lua
callbacks all go through those. **No claim below says "only caller" or "only write site"** — every
count is "direct edges found", and an indirect caller or an aliased-pointer write would not appear.

Field-write lists come from disassembling each method of `LoginManager`, `AccountMgr`,
`FirebaseAccount`, `GoogleAccount`, `FacebookAccount` and `CommonAccount` in full and collecting
store instructions with a register+immediate operand. A write through an aliased pointer, or from a
class outside that set, is not excluded.

## Three distinct state layers (previously conflated)

The earlier draft treated the provider's `eLoginState` at `+0x30` and `LoginManager.is_logined` at
`+0x81` as one flag. They are different fields on different objects, written by different code.

| Layer | Storage | Written by |
|---|---|---|
| 1. Provider authentication | `eLoginState` at provider object `+0x30` (Firebase/Google); Facebook's own at `+0x10` | `FirebaseAccount.SetLoginState` 0x17C6688; Facebook inline |
| 2. Game-server request/response | Lua state — no C# field | Lua side; entry/exit points below |
| 3. Game entry | `LoginManager.is_logined` `+0x81`, `is_entering` `+0x84`, `is_auto` `+0x80`, `m_CurrState` `+0x98` | `LoginManager.OnLoginSuccess` / `EnterGame` / `StartLogin` / `Update` |

## Layer 1 — provider authentication

`AccountMgr` (dump.cs:37319) holds one field `IAccount m_Account; // 0x10`.
`AccountMgr.Login` 0x17C2F78 compares the platform string (`String.op_Equality` at 0x17C3008,
0x17C3040, 0x17C3078), constructs `GoogleAccount`/`FacebookAccount`/`CommonAccount`
(0x17C3024 / 0x17C305C / 0x17C3090), stores it to `m_Account` (`str x20,[x0,#0x10]` at 0x17C3098)
and dispatches. `AccountMgr.IsLogin` 0x17C32D0, `GetToken` 0x17C3444 and `GetLoginState` 0x17C34F4
each load `m_Account` then call the il2cpp interface-slot resolver `bl 0x1626150` with slot `#5`,
`#2`, `#6` — they forward, and perform no SDK call and no flag write.

SDK calls, with the instruction that makes them:

| Provider | Method | Instruction | Callee |
|---|---|---|---|
| Firebase | `FirebaseAccount.Login` 0x17C63D8 | `bl` @0x17C6488 | `GoogleAuthProvider.GetCredential` 0x1AE8648 |
| Firebase | same | `bl` @0x17C64A8 | `FirebaseAuth.get_DefaultInstance` 0x1AEBDC8 |
| Firebase | same | `bl` @0x17C64B8 (x0=instance, x1=credential from 0x17C6488) | **`FirebaseAuth.SignInWithCredentialAsync` 0x1AEC698** |
| Google | `GoogleAccount.Login` 0x17C7058 | `bl` @0x17C70EC | `GoogleSignIn.get_DefaultInstance` 0x1939528 |
| Google | same | `bl` @0x17C70F8 | **`GoogleSignIn.SignIn` 0x1939610** |
| Facebook | `FacebookAccount.Login` 0x17C4DC4 | `bl` @0x17C4E68 / @0x17C4E84 | `FB.get_IsInitialized` 0x1A9600C / `FB.get_IsLoggedIn` 0x1A95F1C |
| Common | `CommonAccount.Login` 0x17C40B4 | `b` (tail) @0x17C4194 | `LuaManager.FireEvent` 0x17356D8 |

Evidence for the SDK addresses in the right-hand column, from the dump (the `bl`
targets above are the call sites; these are the declarations they land on):

```
$ grep -n -B1 'SignInWithCredentialAsync(Credential\|get_DefaultInstance()\|SignIn()\|GetCredential(string' out/recovered/dump.cs
638774-	// RVA: 0x1AE8648 Offset: 0x1AE4648 VA: 0x1AE8648
638775:	public static Credential GetCredential(string idToken, string accessToken) { }
639341-	// RVA: 0x1AEBDC8 Offset: 0x1AE7DC8 VA: 0x1AEBDC8
639342:	public static FirebaseAuth get_DefaultInstance() { }
639388-	// RVA: 0x1AEC698 Offset: 0x1AE8698 VA: 0x1AEC698
639389:	public Task<FirebaseUser> SignInWithCredentialAsync(Credential credential) { }
67458-	// RVA: 0x1939528 Offset: 0x1935528 VA: 0x1939528
67459:	public static GoogleSignIn get_DefaultInstance() { }
67467-	// RVA: 0x1939610 Offset: 0x1935610 VA: 0x1939610
67468:	public Task<GoogleSignInUser> SignIn() { }
```

The enclosing class declarations, from the dump:

```
$ grep -n 'public sealed class FirebaseAuth : IDisposable\|^public class GoogleSignIn //' out/recovered/dump.cs
67439:public class GoogleSignIn // TypeDefIndex: 1844
639258:public sealed class FirebaseAuth : IDisposable // TypeDefIndex: 11890
```

These classes are absent from the Phase 2 dump survey because that survey greps
for login and currency patterns, not SDK types; the addresses above come from the
dump directly.

These are calls into provider SDKs. Whether a given one performs network I/O happens inside the SDK
and is not observable from these call sites.

### The `eLoginState` value is not a success signal

All seven direct edges into `FirebaseAccount.SetLoginState` 0x17C6688, with the `w1` argument and
the instruction that sets it:

| Call site | Kind | Caller | `w1` | Value |
|---|---|---|---|---|
| 0x17C6450 | BL | `FirebaseAccount.Login` | `mov w1,#2` @0x17C6448 | VERIFY_TOKEN |
| 0x17C663C | B | `FirebaseAccount.Login`, after `MyLog.Error` @0x17C6624 | `mov w1,#3` @0x17C6634 | LOGIN_COMPLETE |
| 0x17C6808 | BL | `FirebaseAccount.LoginOut` | `mov w1,wzr` @0x17C6804 | READY_TO_LOGIN |
| 0x17C70E4 | BL | `GoogleAccount.Login` | `mov w1,#1` @0x17C70DC | APPLY_TOKEN |
| 0x17C7270 | B | `GoogleAccount.Login`, after `MyLog.Error` @0x17C725C | `mov w1,#3` @0x17C7268 | LOGIN_COMPLETE |
| 0x17C6B10 | B | `FirebaseAccount.<Login>b__5_0` | `mov w1,#3` @0x17C6B08 | LOGIN_COMPLETE |
| 0x17C7544 | B | `GoogleAccount.<Login>b__6_0` | `mov w1,#3` @0x17C753C | LOGIN_COMPLETE |

`SetLoginState` itself writes the field with `str w20,[x19,#0x30]` @0x17C6700 (`w20` = the `state`
argument saved at 0x17C66BC, `x19` = `this`).

In the Firebase continuation `<Login>b__5_0` 0x17C68E8: the canceled branch (`tbz` @0x17C6968 after
`Task.get_IsCanceled` @0x17C6964) and the faulted branch (`tbz` @0x17C6990 after
`Task.get_IsFaulted` @0x17C698C) each store an error string to `+0x28` (@0x17C697C / @0x17C69D4) and
jump to 0x17C6AFC. The success branch (0x17C6A58) stores the user object to `+0x10` (@0x17C6AF4) and
falls into the same 0x17C6AFC. Both converge on `mov w1,#3` @0x17C6B08.

So **LOGIN_COMPLETE(3) marks "the attempt finished", not "authentication succeeded"** — it is
written on error paths (after `MyLog.Error`) and on cancel/fault continuations as well as on
success. **`LOGIN_FAILED(4)` is written by none of the seven direct edges.** The discriminator
between success and failure is the data, not the enum: user object at `+0x10`, set only on the
success branch, versus the error string at `+0x28`.

(This corrects the earlier draft, which called value 3 a reliable success signal while also noting
error paths write it.)

### Accessor polarity

- `FirebaseAccount.IsLogin` 0x17C68D0, bytes `080840f9 1f0100f1 e0179f1a c0035fd6`:
  `ldr x8,[x0,#0x10]; cmp x8,#0; cset w0,eq; ret` — returns true when the field at `+0x10` is
  **null**. `GetAccountId` 0x17C68BC reads the same field and calls `FirebaseUser.get_UserId` on it,
  so `+0x10` holds the user object. Reported as observed; I have not established which caller relies
  on this result.
- `CommonAccount.IsLogin` 0x17C42DC, bytes `e0031f2a c0035fd6`: `mov w0,wzr; ret` — constant false.
- `CommonAccount.GetState` 0x17C42E4: `mov w0,#3; ret` — constant LOGIN_COMPLETE.
- `FacebookAccount.IsLogin` 0x17C51C0 tail-calls `FB.get_IsLoggedIn` (`b 0x1A95F1C` @0x17C520C).
- `FirebaseAccount.GetToken` 0x17C684C gates on `ldr w8,[x19,#0x30]; cmp w8,#3` @0x17C6878 before
  returning the user id — i.e. it treats state 3 as the gate, with the caveat above.

## Layer 2 — game-server request/response (Lua)

Established C#→Lua edges:

- `LoginManager.Login` 0x172B5EC: `bl LuaManager.RegistRequestCallback 0x172C67C` @0x172B6AC,
  `bl LoginManager.StartLoading` @0x172B6B4, then tail
  `b LuaManager.RunGlobalTableFunction 0x172C804` @0x172B744.
- `LuaManager.RegistRequestCallback` 0x172C67C: `bl LuaDLL.lua_getglobal 0x16EFFC0` @0x172C754,
  `bl LuaHelper.GetTableFunction 0x17305EC` @0x172C770, `bl CSCallback..ctor 0x16F76EC` @0x172C78C,
  `bl LuaHelper.PushCSCallback 0x1731C18` @0x172C798, tail `b LuaHelper.RunFunction 0x172FF9C`
  @0x172C7B8. This establishes that a C# delegate is constructed and pushed into the Lua state.

Established Lua→C# edge into the account layer:

- `GameHelper` (dump.cs:1215) is `[CustomLuaClass]`; `Lua_GameHelper : LuaObject` (dump.cs:589)
  exposes `[MonoPInvokeCallback(typeof(LuaCSFunction))]` thunks, including
  `Lua_GameHelper.LoginAccount_s` 0x1720E30.
- `GameHelper.LoginAccount(string)` 0x1723250 tail-calls `AccountMgr.Login` (`b` @0x17232C4).
- `GameHelper.GetToken()` 0x17232CC tail-calls `AccountMgr.GetToken` (`b` @0x1723338).
- `GameHelper.Post(string url, string post_data, int time_out, LuaFunction callback)` 0x17230A8 is a
  further request surface exposed to Lua.

**Callback registration — resolved (see `login-lua-trace.md` §7).** `LoginManager.OnLoginSuccess(IntPtr L)`
0x172CB24 and `OnLoginFailed(IntPtr L)` 0x172D978 have the `lua_CFunction` shape and read their
arguments off the Lua stack (`LuaHelper.GetString(L,-3)` `bl` @0x172CBE4; `LuaHelper.GetInt(L,-2)`
`bl` @0x172CBF4). An earlier draft of this report called the registration statically unresolvable
because a scan for inline `adrp`+`ldr` loads of the method-pointer slots returns 0 references. **That
conclusion was wrong and is withdrawn.** The slots are zero in the file but carry
`R_AARCH64_RELATIVE` relocations whose addends name the target; `tools/resolve_slots.py` resolves
them. `LoginManager.Start` 0x17298B4 builds an `SLua.CSCallback` per method and registers it via
`LuaManager.RegistLuaEvent(string, CSCallback)` 0x1729E28 under a Lua event name — `"LOGIN.SUCCESS"`
(slot 0x3540850) -> `OnLoginSuccess` (method slot 0x3540810), `"LOGIN.FAILED"` and
`"SERVER_DISCONNECT"` -> `OnLoginFailed`. The decoded Lua `login_mgr.onLoginSuccess` fires
`"LOGIN.SUCCESS"`, so the Lua-to-native edge is the event name. Full disassembly and the six-event
table are in `login-lua-trace.md` §7.

No native→network instruction for the *game server* (as opposed to the provider SDKs) is emitted
from `libil2cpp.so` directly: `CommonAccount.Login` reaches `LuaManager.FireEvent`, and the transport
runs through Lua. The path from the login flow to the websocket is decoded on the Lua side —
`net_agent` -> `sproto_helper` -> `WSHelper.Connect/Send/Close` (0x19865D0 / 0x198679C / 0x1986898) —
in `login-lua-trace.md` §4, not from a native call edge.

## Layer 3 — game entry state

`LoginManager` field map (dump.cs:1584+): `is_auto 0x80`, `is_logined 0x81`, `is_loading 0x82`,
`is_loging 0x83`, `is_entering 0x84`, `is_sdk_inited 0x85`, `current_value 0x88`,
`m_CreditScale 0x8C`, `current_login_platform_ 0x90`, `m_CurrState 0x98`.

Writes found across all `LoginManager` method bodies:

| Field | Instruction | Method | Value / provenance |
|---|---|---|---|
| `is_logined` +0x81 | `strb w20,[x19,#0x81]` @0x172CD0C | `OnLoginSuccess` | `w20` = 1 from `mov w20,#1` @0x172CCF0; `x19` = `this` |
| `is_auto` +0x80 | `strb w8,[x19,#0x80]` @0x172AFE8 | `StartLogin` | set |
| `is_auto` +0x80 | `strb wzr,[x19,#0x80]` @0x172DD5C | `OnLoginFailed` | cleared |
| `is_entering` +0x84 | `strb w8,[x19,#0x84]` @0x172D0D4 | `EnterGame` | `w8` = 1; guarded by `ldrb w8,[x19,#0x84]` @0x172D044 + `cbz` @0x172D048 (re-entry guard) |
| `m_CurrState` +0x98 | `str w0,[x19,#0x98]` @0x172C204 | `Update` | `w0` = return of `AccountMgr.GetLoginState` `bl` @0x172C1E0; compared @0x172C1E4/0x172C1E8 for change detection |
| `is_loading` +0x82 | `strb` @0x172C554 / @0x172C660 | `StartLoading` / `EndLoading` | set / cleared |
| `is_sdk_inited` +0x85 | `strb` @0x172ADD4 / @0x172DE4C | `OnSdkInit` / `<InitSdk>b__23_0` | set |

**`is_logined` and `EnterGame` are on mutually exclusive branches.** In `OnLoginSuccess`:
`ldrb w8,[x19,#0x80]` @0x172CCA0 reads `is_auto`, `cbz w8,#0x172CD14` @0x172CCA4 branches when it is
zero, and 0x172CD14–0x172CD18 is `mov x0,x19; bl LoginManager.EnterGame 0x172CF54`. So when
`is_auto == 0` the method calls `EnterGame` and never touches `is_logined`; when `is_auto != 0` it
takes the UI path (`EndLoading` @0x172CCAC, `Selectable.set_interactable` @0x172CCDC,
`GameObject.SetActive` @0x172CCF4 and @0x172CD08) and sets `is_logined = 1` @0x172CD0C.

Direct edges into `EnterGame` 0x172CF54: one, the `bl` @0x172CD18 above (`B` tail edges: none).
`EnterGame` tail-calls `LoginManager.LoadingOver` (`b` @0x172D0F0) when `CheckContinueStage`
(`bl` @0x172D0D8) returns true, otherwise goes through `GuideMgr.GetFlag` @0x172D110 and
`UiUtils.TransformScene` (`b` @0x172D1F8). Subject to the indirect-edge limit above.

Direct edges into `AccountMgr.Login` 0x17C2F78: `BindAccountPanel.BindChannel` @0x1828ADC,
`SettingsPanel.BtnBindGoogle` @0x1923678, `BtnBindApple` @0x19239E0, `BtnBindFacebook` @0x1923CA0,
and the tail call from `GameHelper.LoginAccount` @0x17232C4. The four panel edges are account
binding, not first login.
Direct edges into `AccountMgr.GetLoginState` 0x17C34F4: one, `LoginManager.Update` @0x172C1E0.

## What remains unresolved

1. Whether the provider SDK calls (`FirebaseAuth.SignInWithCredentialAsync`, `GoogleSignIn.SignIn`,
   the FB SDK) perform network I/O, which is internal to those SDKs and not traced here.
2. All indirect call edges (72,550 `BLR` / 19,265 `BR` sites), so every "direct edges found" count
   above is a lower bound; no "only caller" or "only write site" claim is made.
3. No runtime trace was performed; every statement here is static.

Items the earlier draft listed as unresolved are now resolved and moved out of this list: the
`OnLoginSuccess`/`OnLoginFailed` registration (above, and `login-lua-trace.md` §7), the Lua
table/function names passed to `RunGlobalTableFunction` (`login-lua-trace.md` §7c), and the
login-flow-to-websocket path (decoded in Lua via `sproto_helper` -> `WSHelper`, `login-lua-trace.md`
§4). All were resolved by reading `.rela.dyn` relocations and the decoded Lua, not by a runtime trace.
