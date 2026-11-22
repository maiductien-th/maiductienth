# Phase 2 — method-level analysis (read-only)

Source: `/home/ubuntu/repos/maiductienth/out/recovered/dump.cs` (23M, 9451 classes, arm64-v8a build).

## 1. Exact command output

```
$ grep -c 'RVA: 0x' out/recovered/dump.cs
147889

$ grep -nE '(get_|set_)(Coin|Gem|Zeno|Diamond|Gold|Currency)' out/recovered/dump.cs | head -60
202070:	public int get_CurrencyDecimalDigits() { }
202073:	public string get_CurrencyDecimalSeparator() { }
202079:	public int[] get_CurrencyGroupSizes() { }
202088:	public string get_CurrencyGroupSeparator() { }
202091:	public string get_CurrencySymbol() { }
202103:	public int get_CurrencyNegativePattern() { }
202130:	public int get_CurrencyPositivePattern() { }
203435:	public virtual string get_CurrencyEnglishName() { }
203438:	public virtual string get_CurrencySymbol() { }
203459:	public virtual string get_CurrencyNativeName() { }
596356:	public string get_Currency() { }
596360:	private void set_Currency(string value) { }
628066:	public string get_Currency() { }
628070:	private void set_Currency(string value) { }
628830:	public string get_Currency() { }
628834:	private void set_Currency(string value) { }
629535:	public string get_Currency() { }
629539:	private void set_Currency(string value) { }
629894:	public string get_Currency() { }
629898:	private void set_Currency(string value) { }

$ grep -niE 'class .*\b(Wallet|Currency|PlayerData|UserData|ResourceData)\b' out/recovered/dump.cs | head -40
(no output)
```

The third pattern returns nothing; with the `\b` boundaries dropped it returns 5 class declarations:

```
596329:public class CurrencyAmount // TypeDefIndex: 10740
625008:private sealed class NetPacketProcessor.<>c__DisplayClass24_0<T, TUserData> // TypeDefIndex: 11581
625064:private sealed class NetPacketProcessor.<>c__DisplayClass26_0<T, TUserData> // TypeDefIndex: 11583
625098:private sealed class NetPacketProcessor.<>c__DisplayClass27_0<T, TUserData> // TypeDefIndex: 11584
625152:private sealed class NetPacketProcessor.<>c__DisplayClass29_0<T, TUserData> // TypeDefIndex: 11586
```

## 2. One row per getter/setter hit (20 hits)

| file:line | Class (declared at) | Method | Return type | RVA |
|---|---|---|---|---|
| dump.cs:202070 | `NumberFormatInfo` (dump.cs:201960) | `public int get_CurrencyDecimalDigits() { }` | `int` | `0x28F4D6C` |
| dump.cs:202073 | `NumberFormatInfo` (dump.cs:201960) | `public string get_CurrencyDecimalSeparator() { }` | `string` | `0x28F4D74` |
| dump.cs:202079 | `NumberFormatInfo` (dump.cs:201960) | `public int[] get_CurrencyGroupSizes() { }` | `int[]` | `0x28F4D84` |
| dump.cs:202088 | `NumberFormatInfo` (dump.cs:201960) | `public string get_CurrencyGroupSeparator() { }` | `string` | `0x28F4EEC` |
| dump.cs:202091 | `NumberFormatInfo` (dump.cs:201960) | `public string get_CurrencySymbol() { }` | `string` | `0x28F4EF4` |
| dump.cs:202103 | `NumberFormatInfo` (dump.cs:201960) | `public int get_CurrencyNegativePattern() { }` | `int` | `0x28F4F98` |
| dump.cs:202130 | `NumberFormatInfo` (dump.cs:201960) | `public int get_CurrencyPositivePattern() { }` | `int` | `0x28F4FE0` |
| dump.cs:203435 | `RegionInfo` (dump.cs:203378) | `public virtual string get_CurrencyEnglishName() { }` | `string` | `0x290C52C` |
| dump.cs:203438 | `RegionInfo` (dump.cs:203378) | `public virtual string get_CurrencySymbol() { }` | `string` | `0x290C534` |
| dump.cs:203459 | `RegionInfo` (dump.cs:203378) | `public virtual string get_CurrencyNativeName() { }` | `string` | `0x290C5F0` |
| dump.cs:596356 | `CurrencyAmount` (dump.cs:596329) | `public string get_Currency() { }` | `string` | `0x1A9DD4C` |
| dump.cs:596360 | `CurrencyAmount` (dump.cs:596329) | `private void set_Currency(string value) { }` | `void` | `0x1A9DD54` |
| dump.cs:628066 | `AdjustAdRevenue` (dump.cs:628015) | `public string get_Currency() { }` | `string` | `0x16D6DDC` |
| dump.cs:628070 | `AdjustAdRevenue` (dump.cs:628015) | `private void set_Currency(string value) { }` | `void` | `0x16D6DE4` |
| dump.cs:628830 | `AdjustAppStoreSubscription` (dump.cs:628793) | `public string get_Currency() { }` | `string` | `0x16DD57C` |
| dump.cs:628834 | `AdjustAppStoreSubscription` (dump.cs:628793) | `private void set_Currency(string value) { }` | `void` | `0x16DD584` |
| dump.cs:629535 | `AdjustEvent` (dump.cs:629483) | `public string get_Currency() { }` | `string` | `0x16DF17C` |
| dump.cs:629539 | `AdjustEvent` (dump.cs:629483) | `private void set_Currency(string value) { }` | `void` | `0x16DF184` |
| dump.cs:629894 | `AdjustPlayStoreSubscription` (dump.cs:629851) | `public string get_Currency() { }` | `string` | `0x16E011C` |
| dump.cs:629898 | `AdjustPlayStoreSubscription` (dump.cs:629851) | `private void set_Currency(string value) { }` | `void` | `0x16E0124` |

Types: 4 of the 20 are not strings — `int get_CurrencyDecimalDigits()`, `int[] get_CurrencyGroupSizes()`, `int get_CurrencyNegativePattern()`, `int get_CurrencyPositivePattern()`. The other 16 are `string` getters or `void` setters. All 20 belong to `System.Globalization` number formatting (`NumberFormatInfo`, `RegionInfo`) or to store/IAP currency codes (`CurrencyAmount`, the Adjust SDK classes); none is a game-balance amount.

## 3. Candidate class excerpts (`sed -n 'start,start+40p'`)

#### `LoginManager` — `sed -n '1584,1624p' out/recovered/dump.cs`

```
public class LoginManager : MonoBehaviour // TypeDefIndex: 36
{
	// Fields
	public GameObject ServerList; // 0x20
	public TextMeshProUGUI versionText; // 0x28
	public RectTransform credits; // 0x30
	public GameObject LoginPanel; // 0x38
	public GameObject StartTip; // 0x40
	public GameObject Title; // 0x48
	public GameObject ConnectingText; // 0x50
	public DotDance connectTip; // 0x58
	public Slider LoginSlider1; // 0x60
	public Slider LoginSlider2; // 0x68
	public string EntryScene; // 0x70
	public GameObject btn_switchAccount; // 0x78
	private bool is_auto; // 0x80
	private bool is_logined; // 0x81
	private bool is_loading; // 0x82
	private bool is_loging; // 0x83
	private bool is_entering; // 0x84
	private bool is_sdk_inited; // 0x85
	private float current_value; // 0x88
	private float m_CreditScale; // 0x8C
	private string current_login_platform_; // 0x90
	private eLoginState m_CurrState; // 0x98

	// Methods

	// RVA: 0x17298B4 Offset: 0x17258B4 VA: 0x17298B4
	private void Start() { }

	// RVA: 0x172AAB0 Offset: 0x1726AB0 VA: 0x172AAB0
	public void InitSdk() { }

	// RVA: 0x172ADD0 Offset: 0x1726DD0 VA: 0x172ADD0
	public void OnSdkInit() { }

	// RVA: 0x172ADDC Offset: 0x1726DDC VA: 0x172ADDC
	private void CheckStartLogin() { }

	// RVA: 0x172B020 Offset: 0x1727020 VA: 0x172B020
```

#### `Lua_WSHelper` — `sed -n '911,951p' out/recovered/dump.cs`

```
public class Lua_WSHelper : LuaObject // TypeDefIndex: 16
{
	// Methods

	[Preserve]
	[MonoPInvokeCallback(typeof(LuaCSFunction))]
	// RVA: 0x17260C8 Offset: 0x17220C8 VA: 0x17260C8
	public static int Connect_s(IntPtr l) { }

	[MonoPInvokeCallback(typeof(LuaCSFunction))]
	[Preserve]
	// RVA: 0x1726238 Offset: 0x1722238 VA: 0x1726238
	public static int Send_s(IntPtr l) { }

	[MonoPInvokeCallback(typeof(LuaCSFunction))]
	[Preserve]
	// RVA: 0x172639C Offset: 0x172239C VA: 0x172639C
	public static int Close_s(IntPtr l) { }

	[Preserve]
	// RVA: 0x17264C4 Offset: 0x17224C4 VA: 0x17264C4
	public static void reg(IntPtr l) { }

	// RVA: 0x172667C Offset: 0x172267C VA: 0x172667C
	public void .ctor() { }
}

// Namespace: 
public class EntityData // TypeDefIndex: 17
{
	// Fields
	public long max_hp; // 0x10
	public long hp; // 0x18
	public long attack; // 0x20
	public long raw_max_hp; // 0x28
	public long raw_attack; // 0x30

	// Methods

	// RVA: 0x17266D4 Offset: 0x17226D4 VA: 0x17266D4
	public void .ctor() { }
```

#### `LuaManager` — `sed -n '2100,2140p' out/recovered/dump.cs`

```
public class LuaManager // TypeDefIndex: 50
{
	// Fields
	public const int LUA_DEFAULT_FPS = 10;
	public bool is_alive_; // 0x10
	private LuaSvr _lua_svr; // 0x18
	private IntPtr lua_state_; // 0x20
	private int loop_func_index; // 0x28
	private int emit_func_index; // 0x2C
	private static Dictionary<string, CSCallback> lua_event_list_; // 0x0
	private static Dictionary<int, CSCallback> request_callback_list_; // 0x8
	private static Dictionary<string, int> lua_reg_list_; // 0x10
	private Dictionary<string, int> lua_reg_index_; // 0x30
	private static string[] lua_path_list_; // 0x18
	private static LuaManager _instance; // 0x20
	private bool isStart; // 0x38

	// Properties
	public static LuaManager Instance { get; }

	// Methods

	// RVA: 0x1729D80 Offset: 0x1725D80 VA: 0x1729D80
	public static LuaManager get_Instance() { }

	// RVA: 0x173467C Offset: 0x173067C VA: 0x173467C
	private void .ctor() { }

	// RVA: 0x17348EC Offset: 0x17308EC VA: 0x17348EC
	private static TextAsset loadLua(string file_path, string lua_path) { }

	// RVA: 0x17349B8 Offset: 0x17309B8 VA: 0x17349B8
	private static byte[] LuaLoader(string script_path, ref string absoluteFn) { }

	// RVA: 0x17347FC Offset: 0x17307FC VA: 0x17347FC
	public void AddErrorReport() { }

	// RVA: 0x1734AF0 Offset: 0x1730AF0 VA: 0x1734AF0
	public IntPtr GetState() { }

	// RVA: 0x1734AF8 Offset: 0x1730AF8 VA: 0x1734AF8
```

#### `WSConnection` — `sed -n '7696,7736p' out/recovered/dump.cs`

```
public class WSConnection : MonoBehaviour // TypeDefIndex: 217
{
	// Fields
	public WebSocket websocket; // 0x20

	// Methods

	[AsyncStateMachine(typeof(WSConnection.<Init>d__1))]
	// RVA: 0x18783B0 Offset: 0x18743B0 VA: 0x18783B0
	public void Init(string host, int port) { }

	// RVA: 0x1878488 Offset: 0x1874488 VA: 0x1878488
	private void Update() { }

	[AsyncStateMachine(typeof(WSConnection.<Send>d__3))]
	// RVA: 0x187849C Offset: 0x187449C VA: 0x187849C
	public void Send(byte[] data) { }

	[AsyncStateMachine(typeof(WSConnection.<Close>d__4))]
	// RVA: 0x187856C Offset: 0x187456C VA: 0x187856C
	public void Close() { }

	// RVA: 0x1878620 Offset: 0x1874620 VA: 0x1878620
	public void .ctor() { }
}

// Namespace: 
[CustomLuaClass]
public static class WSHelper // TypeDefIndex: 218
{
	// Fields
	private static GameObject _go; // 0x0
	private static WSConnection _conn; // 0x8

	// Methods

	// RVA: 0x19865D0 Offset: 0x19825D0 VA: 0x19865D0
	public static int Connect(string host, int port) { }

	// RVA: 0x198679C Offset: 0x198279C VA: 0x198679C
	public static int Send(byte[] data) { }
```

#### `WSHelper` — `sed -n '7724,7764p' out/recovered/dump.cs`

```
public static class WSHelper // TypeDefIndex: 218
{
	// Fields
	private static GameObject _go; // 0x0
	private static WSConnection _conn; // 0x8

	// Methods

	// RVA: 0x19865D0 Offset: 0x19825D0 VA: 0x19865D0
	public static int Connect(string host, int port) { }

	// RVA: 0x198679C Offset: 0x198279C VA: 0x198679C
	public static int Send(byte[] data) { }

	// RVA: 0x1986898 Offset: 0x1982898 VA: 0x1986898
	public static int Close() { }
}

// Namespace: 
private struct UnitySourceGeneratedAssemblyMonoScriptTypes_v1.MonoScriptData // TypeDefIndex: 219
{
	// Fields
	public byte[] FilePathsData; // 0x0
	public byte[] TypesData; // 0x8
	public int TotalTypes; // 0x10
	public int TotalFiles; // 0x14
	public bool IsEditorOnly; // 0x18
}

// Namespace: 
[EditorBrowsable(1)]
[GeneratedCode("Unity.MonoScriptGenerator.MonoScriptInfoGenerator", null)]
[CompilerGenerated]
internal class UnitySourceGeneratedAssemblyMonoScriptTypes_v1 // TypeDefIndex: 220
{
	// Methods

	// RVA: 0x1986998 Offset: 0x1982998 VA: 0x1986998
	private static UnitySourceGeneratedAssemblyMonoScriptTypes_v1.MonoScriptData Get() { }

	// RVA: 0x1986A98 Offset: 0x1982A98 VA: 0x1986A98
```

#### `GameData` — `sed -n '15320,15360p' out/recovered/dump.cs`

```
public class GameData // TypeDefIndex: 380
{
	// Fields
	private string m_Name; // 0x10
	private readonly Dictionary<string, double> m_NumberDict; // 0x18
	private readonly Dictionary<string, List<double>> m_NumberList; // 0x20
	private readonly Dictionary<string, string> m_StringDict; // 0x28
	private readonly Dictionary<string, List<string>> m_StringList; // 0x30
	private readonly Dictionary<string, GameData> m_GameDataDict; // 0x38
	private readonly Dictionary<string, List<GameData>> m_GameDataList; // 0x40
	private static readonly GameData m_EmptyData; // 0x0

	// Properties
	public string name { get; }
	public static GameData empty { get; }

	// Methods

	// RVA: 0x19B9288 Offset: 0x19B5288 VA: 0x19B9288
	public string get_name() { }

	// RVA: 0x19B9290 Offset: 0x19B5290 VA: 0x19B9290
	public static GameData get_empty() { }

	// RVA: 0x19AFF90 Offset: 0x19ABF90 VA: 0x19AFF90
	public void .ctor() { }

	// RVA: 0x19B92E8 Offset: 0x19B52E8 VA: 0x19B92E8
	public void .ctor(string name) { }

	// RVA: 0x19B9314 Offset: 0x19B5314 VA: 0x19B9314 Slot: 4
	public virtual void Set(string key, double value) { }

	// RVA: 0x19B937C Offset: 0x19B537C VA: 0x19B937C Slot: 5
	public virtual void Set(string key, long value) { }

	// RVA: 0x19B93E4 Offset: 0x19B53E4 VA: 0x19B93E4 Slot: 6
	public virtual void Set(string key, List<int> value) { }

	// RVA: 0x19B96DC Offset: 0x19B56DC VA: 0x19B96DC Slot: 7
	public virtual void Set(string key, List<float> value) { }
```

#### `AccountMgr` — `sed -n '37319,37359p' out/recovered/dump.cs`

```
public class AccountMgr : Singleton<AccountMgr> // TypeDefIndex: 979
{
	// Fields
	private IAccount m_Account; // 0x10

	// Methods

	// RVA: 0x17C2F0C Offset: 0x17BEF0C VA: 0x17C2F0C
	public void .ctor() { }

	// RVA: 0x17C2F78 Offset: 0x17BEF78 VA: 0x17C2F78
	public void Login(string login_platform) { }

	// RVA: 0x17C32D0 Offset: 0x17BF2D0 VA: 0x17C32D0
	public bool IsLogin() { }

	// RVA: 0x17C3380 Offset: 0x17BF380 VA: 0x17C3380
	public void LoginOut() { }

	// RVA: 0x17C3444 Offset: 0x17BF444 VA: 0x17C3444
	public string GetToken() { }

	// RVA: 0x17C34F4 Offset: 0x17BF4F4 VA: 0x17C34F4
	public eLoginState GetLoginState() { }

	// RVA: 0x17C35A4 Offset: 0x17BF5A4 VA: 0x17C35A4
	public string GetLastError() { }
}

// Namespace: Game
public class AdsMgr : Singleton<AdsMgr> // TypeDefIndex: 980
{
	// Fields
	private IAds m_Ads; // 0x10
	private bool m_IsInited; // 0x18

	// Methods

	// RVA: 0x17C3654 Offset: 0x17BF654 VA: 0x17C3654
	public void .ctor() { }

```

#### `CommonAccount` — `sed -n '37407,37447p' out/recovered/dump.cs`

```
public class CommonAccount : IAccount // TypeDefIndex: 982
{
	// Fields
	private string m_Token; // 0x10
	protected string m_lastError; // 0x18

	// Methods

	// RVA: 0x17C40B4 Offset: 0x17C00B4 VA: 0x17C40B4 Slot: 4
	public void Login() { }

	// RVA: 0x17C419C Offset: 0x17C019C VA: 0x17C419C Slot: 5
	public void LoginOut() { }

	// RVA: 0x17C41A0 Offset: 0x17C01A0 VA: 0x17C41A0 Slot: 6
	public string GetToken() { }

	// RVA: 0x17C42CC Offset: 0x17C02CC VA: 0x17C42CC Slot: 8
	public string GetLastError() { }

	// RVA: 0x17C42D4 Offset: 0x17C02D4 VA: 0x17C42D4 Slot: 7
	public string GetAccountId() { }

	// RVA: 0x17C42DC Offset: 0x17C02DC VA: 0x17C42DC Slot: 9
	public bool IsLogin() { }

	// RVA: 0x17C42E4 Offset: 0x17C02E4 VA: 0x17C42E4 Slot: 10
	public eLoginState GetState() { }

	// RVA: 0x17C3278 Offset: 0x17BF278 VA: 0x17C3278
	public void .ctor() { }
}

// Namespace: 
[CompilerGenerated]
private sealed class CommonAds.<>c__DisplayClass4_0 // TypeDefIndex: 983
{
	// Fields
	public Action onSuccess; // 0x10

	// Methods
```

#### `FacebookAccount` — `sed -n '37545,37585p' out/recovered/dump.cs`

```
public class FacebookAccount : IAccount // TypeDefIndex: 987
{
	// Fields
	protected eLoginState login_state; // 0x10
	private string m_UserId; // 0x18
	protected string m_lastError; // 0x20

	// Methods

	// RVA: 0x17C3170 Offset: 0x17BF170 VA: 0x17C3170
	public void .ctor() { }

	// RVA: 0x17C4DC4 Offset: 0x17C0DC4 VA: 0x17C4DC4 Slot: 4
	public void Login() { }

	// RVA: 0x17C4FFC Offset: 0x17C0FFC VA: 0x17C4FFC Slot: 5
	public void LoginOut() { }

	// RVA: 0x17C504C Offset: 0x17C104C VA: 0x17C504C Slot: 6
	public string GetToken() { }

	// RVA: 0x17C5118 Offset: 0x17C1118 VA: 0x17C5118 Slot: 7
	public string GetAccountId() { }

	// RVA: 0x17C51B8 Offset: 0x17C11B8 VA: 0x17C51B8 Slot: 8
	public string GetLastError() { }

	// RVA: 0x17C51C0 Offset: 0x17C11C0 VA: 0x17C51C0 Slot: 9
	public bool IsLogin() { }

	// RVA: 0x17C5210 Offset: 0x17C1210 VA: 0x17C5210 Slot: 10
	public eLoginState GetState() { }

	// RVA: 0x17C5218 Offset: 0x17C1218 VA: 0x17C5218
	public int onLogout(IntPtr L) { }

	[CompilerGenerated]
	// RVA: 0x17C522C Offset: 0x17C122C VA: 0x17C522C
	private void <Login>b__4_0(ILoginResult result) { }
}

```

#### `FirebaseAccount` — `sed -n '37713,37753p' out/recovered/dump.cs`

```
public class FirebaseAccount : IAccount // TypeDefIndex: 991
{
	// Fields
	protected FirebaseUser m_UserInfo; // 0x10
	protected string idToken; // 0x18
	protected string accessToken; // 0x20
	protected string m_lastError; // 0x28
	protected eLoginState login_state; // 0x30

	// Methods

	// RVA: 0x17C63D8 Offset: 0x17C23D8 VA: 0x17C63D8 Slot: 11
	public virtual void Login() { }

	// RVA: 0x17C6688 Offset: 0x17C2688 VA: 0x17C6688
	protected void SetLoginState(eLoginState state) { }

	// RVA: 0x17C67CC Offset: 0x17C27CC VA: 0x17C67CC Slot: 12
	public virtual void LoginOut() { }

	// RVA: 0x17C684C Offset: 0x17C284C VA: 0x17C684C Slot: 6
	public string GetToken() { }

	// RVA: 0x17C68B4 Offset: 0x17C28B4 VA: 0x17C68B4 Slot: 8
	public string GetLastError() { }

	// RVA: 0x17C68BC Offset: 0x17C28BC VA: 0x17C68BC Slot: 7
	public string GetAccountId() { }

	// RVA: 0x17C68D0 Offset: 0x17C28D0 VA: 0x17C68D0 Slot: 9
	public bool IsLogin() { }

	// RVA: 0x17C68E0 Offset: 0x17C28E0 VA: 0x17C68E0 Slot: 10
	public eLoginState GetState() { }

	// RVA: 0x17C6380 Offset: 0x17C2380 VA: 0x17C6380
	public void .ctor() { }

	[CompilerGenerated]
	// RVA: 0x17C68E8 Offset: 0x17C28E8 VA: 0x17C68E8
	private void <Login>b__5_0(Task<FirebaseUser> task) { }
```

#### `IAccount` — `sed -n '37825,37865p' out/recovered/dump.cs`

```
public interface IAccount // TypeDefIndex: 994
{
	// Methods

	// RVA: -1 Offset: -1 Slot: 0
	public abstract void Login();

	// RVA: -1 Offset: -1 Slot: 1
	public abstract void LoginOut();

	// RVA: -1 Offset: -1 Slot: 2
	public abstract string GetToken();

	// RVA: -1 Offset: -1 Slot: 3
	public abstract string GetAccountId();

	// RVA: -1 Offset: -1 Slot: 4
	public abstract string GetLastError();

	// RVA: -1 Offset: -1 Slot: 5
	public abstract bool IsLogin();

	// RVA: -1 Offset: -1 Slot: 6
	public abstract eLoginState GetState();
}

// Namespace: Game
public interface IAds // TypeDefIndex: 995
{
	// Methods

	// RVA: -1 Offset: -1 Slot: 0
	public abstract void Init();

	// RVA: -1 Offset: -1 Slot: 1
	public abstract bool IsSupportRewardVideoAd();

	// RVA: -1 Offset: -1 Slot: 2
	public abstract void LoadRewardVideoAd();

	// RVA: -1 Offset: -1 Slot: 3
```

#### `NumberFormatInfo` — `sed -n '201960,202000p' out/recovered/dump.cs`

```
public sealed class NumberFormatInfo : ICloneable, IFormatProvider // TypeDefIndex: 3875
{
	// Fields
	private static NumberFormatInfo invariantInfo; // 0x0
	internal int[] numberGroupSizes; // 0x10
	internal int[] currencyGroupSizes; // 0x18
	internal int[] percentGroupSizes; // 0x20
	internal string positiveSign; // 0x28
	internal string negativeSign; // 0x30
	internal string numberDecimalSeparator; // 0x38
	internal string numberGroupSeparator; // 0x40
	internal string currencyGroupSeparator; // 0x48
	internal string currencyDecimalSeparator; // 0x50
	internal string currencySymbol; // 0x58
	internal string ansiCurrencySymbol; // 0x60
	internal string nanSymbol; // 0x68
	internal string positiveInfinitySymbol; // 0x70
	internal string negativeInfinitySymbol; // 0x78
	internal string percentDecimalSeparator; // 0x80
	internal string percentGroupSeparator; // 0x88
	internal string percentSymbol; // 0x90
	internal string perMilleSymbol; // 0x98
	[OptionalField(VersionAdded = 2)]
	internal string[] nativeDigits; // 0xA0
	[OptionalField(VersionAdded = 1)]
	internal int m_dataItem; // 0xA8
	internal int numberDecimalDigits; // 0xAC
	internal int currencyDecimalDigits; // 0xB0
	internal int currencyPositivePattern; // 0xB4
	internal int currencyNegativePattern; // 0xB8
	internal int numberNegativePattern; // 0xBC
	internal int percentPositivePattern; // 0xC0
	internal int percentNegativePattern; // 0xC4
	internal int percentDecimalDigits; // 0xC8
	[OptionalField(VersionAdded = 2)]
	internal int digitSubstitution; // 0xCC
	internal bool isReadOnly; // 0xD0
	[OptionalField(VersionAdded = 1)]
	internal bool m_useUserOverride; // 0xD1
	[OptionalField(VersionAdded = 2)]
	internal bool m_isInvariant; // 0xD2
```

#### `RegionInfo` — `sed -n '203378,203418p' out/recovered/dump.cs`

```
public class RegionInfo // TypeDefIndex: 3897
{
	// Fields
	private static RegionInfo currentRegion; // 0x0
	private int regionId; // 0x10
	private string iso2Name; // 0x18
	private string iso3Name; // 0x20
	private string win3Name; // 0x28
	private string englishName; // 0x30
	private string nativeName; // 0x38
	private string currencySymbol; // 0x40
	private string isoCurrencySymbol; // 0x48
	private string currencyEnglishName; // 0x50
	private string currencyNativeName; // 0x58

	// Properties
	public static RegionInfo CurrentRegion { get; }
	[ComVisible(False)]
	public virtual string CurrencyEnglishName { get; }
	public virtual string CurrencySymbol { get; }
	[MonoTODO("DisplayName currently only returns the EnglishName")]
	public virtual string DisplayName { get; }
	public virtual string EnglishName { get; }
	[ComVisible(False)]
	public virtual int GeoId { get; }
	public virtual bool IsMetric { get; }
	public virtual string ISOCurrencySymbol { get; }
	[ComVisible(False)]
	public virtual string NativeName { get; }
	[ComVisible(False)]
	public virtual string CurrencyNativeName { get; }
	public virtual string Name { get; }
	public virtual string ThreeLetterISORegionName { get; }
	public virtual string ThreeLetterWindowsRegionName { get; }
	public virtual string TwoLetterISORegionName { get; }

	// Methods

	// RVA: 0x290BF98 Offset: 0x2907F98 VA: 0x290BF98
	public static RegionInfo get_CurrentRegion() { }

```

#### `CurrencyAmount` — `sed -n '596329,596369p' out/recovered/dump.cs`

```
public class CurrencyAmount // TypeDefIndex: 10740
{
	// Fields
	[CompilerGenerated]
	private string <Amount>k__BackingField; // 0x10
	[CompilerGenerated]
	private string <Currency>k__BackingField; // 0x18

	// Properties
	public string Amount { get; set; }
	public string Currency { get; set; }

	// Methods

	// RVA: 0x1A9DCF8 Offset: 0x1A99CF8 VA: 0x1A9DCF8
	internal void .ctor(string amount, string currency) { }

	[CompilerGenerated]
	// RVA: 0x1A9DD3C Offset: 0x1A99D3C VA: 0x1A9DD3C
	public string get_Amount() { }

	[CompilerGenerated]
	// RVA: 0x1A9DD44 Offset: 0x1A99D44 VA: 0x1A9DD44
	private void set_Amount(string value) { }

	[CompilerGenerated]
	// RVA: 0x1A9DD4C Offset: 0x1A99D4C VA: 0x1A9DD4C
	public string get_Currency() { }

	[CompilerGenerated]
	// RVA: 0x1A9DD54 Offset: 0x1A99D54 VA: 0x1A9DD54
	private void set_Currency(string value) { }

	// RVA: 0x1A9DD5C Offset: 0x1A99D5C VA: 0x1A9DD5C Slot: 3
	public override string ToString() { }
}

// Namespace: Facebook.Unity
public class Product // TypeDefIndex: 10741
{
	// Fields
```

#### `AdjustAdRevenue` — `sed -n '628015,628055p' out/recovered/dump.cs`

```
public class AdjustAdRevenue // TypeDefIndex: 11637
{
	// Fields
	private List<string> innerCallbackParameters; // 0x10
	private List<string> innerPartnerParameters; // 0x18
	[CompilerGenerated]
	private string <Source>k__BackingField; // 0x20
	[CompilerGenerated]
	private Nullable<double> <Revenue>k__BackingField; // 0x28
	[CompilerGenerated]
	private string <Currency>k__BackingField; // 0x38
	[CompilerGenerated]
	private Nullable<int> <AdImpressionsCount>k__BackingField; // 0x40
	[CompilerGenerated]
	private string <AdRevenueNetwork>k__BackingField; // 0x48
	[CompilerGenerated]
	private string <AdRevenueUnit>k__BackingField; // 0x50
	[CompilerGenerated]
	private string <AdRevenuePlacement>k__BackingField; // 0x58

	// Properties
	public string Source { get; set; }
	public Nullable<double> Revenue { get; set; }
	public string Currency { get; set; }
	public Nullable<int> AdImpressionsCount { get; set; }
	public string AdRevenueNetwork { get; set; }
	public string AdRevenueUnit { get; set; }
	public string AdRevenuePlacement { get; set; }
	public ReadOnlyCollection<string> CallbackParameters { get; }
	public ReadOnlyCollection<string> PartnerParameters { get; }

	// Methods

	[CompilerGenerated]
	// RVA: 0x16D6DB8 Offset: 0x16D2DB8 VA: 0x16D6DB8
	public string get_Source() { }

	[CompilerGenerated]
	// RVA: 0x16D6DC0 Offset: 0x16D2DC0 VA: 0x16D6DC0
	private void set_Source(string value) { }

```

#### `AdjustAppStoreSubscription` — `sed -n '628793,628833p' out/recovered/dump.cs`

```
public class AdjustAppStoreSubscription // TypeDefIndex: 11670
{
	// Fields
	private List<string> innerCallbackParameters; // 0x10
	private List<string> innerPartnerParameters; // 0x18
	[CompilerGenerated]
	private string <Price>k__BackingField; // 0x20
	[CompilerGenerated]
	private string <Currency>k__BackingField; // 0x28
	[CompilerGenerated]
	private string <TransactionId>k__BackingField; // 0x30
	[CompilerGenerated]
	private string <TransactionDate>k__BackingField; // 0x38
	[CompilerGenerated]
	private string <SalesRegion>k__BackingField; // 0x40

	// Properties
	public string Price { get; set; }
	public string Currency { get; set; }
	public string TransactionId { get; set; }
	public string TransactionDate { get; set; }
	public string SalesRegion { get; set; }
	public ReadOnlyCollection<string> CallbackParameters { get; }
	public ReadOnlyCollection<string> PartnerParameters { get; }

	// Methods

	[CompilerGenerated]
	// RVA: 0x16DD56C Offset: 0x16D956C VA: 0x16DD56C
	public string get_Price() { }

	[CompilerGenerated]
	// RVA: 0x16DD574 Offset: 0x16D9574 VA: 0x16DD574
	private void set_Price(string value) { }

	[CompilerGenerated]
	// RVA: 0x16DD57C Offset: 0x16D957C VA: 0x16DD57C
	public string get_Currency() { }

	[CompilerGenerated]
	// RVA: 0x16DD584 Offset: 0x16D9584 VA: 0x16DD584
```

#### `AdjustEvent` — `sed -n '629483,629523p' out/recovered/dump.cs`

```
public class AdjustEvent // TypeDefIndex: 11676
{
	// Fields
	private List<string> innerCallbackParameters; // 0x10
	private List<string> innerPartnerParameters; // 0x18
	[CompilerGenerated]
	private string <EventToken>k__BackingField; // 0x20
	[CompilerGenerated]
	private Nullable<double> <Revenue>k__BackingField; // 0x28
	[CompilerGenerated]
	private string <Currency>k__BackingField; // 0x38
	[CompilerGenerated]
	private string <CallbackId>k__BackingField; // 0x40
	[CompilerGenerated]
	private string <DeduplicationId>k__BackingField; // 0x48
	[CompilerGenerated]
	private string <ProductId>k__BackingField; // 0x50
	[CompilerGenerated]
	private string <TransactionId>k__BackingField; // 0x58
	public string PurchaseToken; // 0x60

	// Properties
	public string EventToken { get; set; }
	public Nullable<double> Revenue { get; set; }
	public string Currency { get; set; }
	public string CallbackId { get; set; }
	public string DeduplicationId { get; set; }
	public string ProductId { get; set; }
	public ReadOnlyCollection<string> CallbackParameters { get; }
	public ReadOnlyCollection<string> PartnerParameters { get; }
	public string TransactionId { get; set; }

	// Methods

	[CompilerGenerated]
	// RVA: 0x16DF158 Offset: 0x16DB158 VA: 0x16DF158
	public string get_EventToken() { }

	[CompilerGenerated]
	// RVA: 0x16DF160 Offset: 0x16DB160 VA: 0x16DF160
	private void set_EventToken(string value) { }
```

#### `AdjustPlayStoreSubscription` — `sed -n '629851,629891p' out/recovered/dump.cs`

```
public class AdjustPlayStoreSubscription // TypeDefIndex: 11682
{
	// Fields
	private List<string> innerCallbackParameters; // 0x10
	private List<string> innerPartnerParameters; // 0x18
	[CompilerGenerated]
	private string <Price>k__BackingField; // 0x20
	[CompilerGenerated]
	private string <Currency>k__BackingField; // 0x28
	[CompilerGenerated]
	private string <ProductId>k__BackingField; // 0x30
	[CompilerGenerated]
	private string <OrderId>k__BackingField; // 0x38
	[CompilerGenerated]
	private string <Signature>k__BackingField; // 0x40
	[CompilerGenerated]
	private string <PurchaseToken>k__BackingField; // 0x48
	[CompilerGenerated]
	private string <PurchaseTime>k__BackingField; // 0x50

	// Properties
	public string Price { get; set; }
	public string Currency { get; set; }
	public string ProductId { get; set; }
	public string OrderId { get; set; }
	public string Signature { get; set; }
	public string PurchaseToken { get; set; }
	public string PurchaseTime { get; set; }
	public ReadOnlyCollection<string> CallbackParameters { get; }
	public ReadOnlyCollection<string> PartnerParameters { get; }

	// Methods

	[CompilerGenerated]
	// RVA: 0x16E010C Offset: 0x16DC10C VA: 0x16E010C
	public string get_Price() { }

	[CompilerGenerated]
	// RVA: 0x16E0114 Offset: 0x16DC114 VA: 0x16E0114
	private void set_Price(string value) { }

```

## 4. Per-method tables (file:line, class, method, RVA)

### `AccountMgr` — out/recovered/dump.cs:37319–37346

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:37327 | `AccountMgr` | `public void .ctor()` | `0x17C2F0C` |
| dump.cs:37330 | `AccountMgr` | `public void Login(string login_platform)` | `0x17C2F78` |
| dump.cs:37333 | `AccountMgr` | `public bool IsLogin()` | `0x17C32D0` |
| dump.cs:37336 | `AccountMgr` | `public void LoginOut()` | `0x17C3380` |
| dump.cs:37339 | `AccountMgr` | `public string GetToken()` | `0x17C3444` |
| dump.cs:37342 | `AccountMgr` | `public eLoginState GetLoginState()` | `0x17C34F4` |
| dump.cs:37345 | `AccountMgr` | `public string GetLastError()` | `0x17C35A4` |

### `IAccount` — out/recovered/dump.cs:37825–37849

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:37830 | `IAccount` | `public abstract void Login()` | `-1` |
| dump.cs:37833 | `IAccount` | `public abstract void LoginOut()` | `-1` |
| dump.cs:37836 | `IAccount` | `public abstract string GetToken()` | `-1` |
| dump.cs:37839 | `IAccount` | `public abstract string GetAccountId()` | `-1` |
| dump.cs:37842 | `IAccount` | `public abstract string GetLastError()` | `-1` |
| dump.cs:37845 | `IAccount` | `public abstract bool IsLogin()` | `-1` |
| dump.cs:37848 | `IAccount` | `public abstract eLoginState GetState()` | `-1` |

### `CommonAccount` — out/recovered/dump.cs:37407–37438

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:37416 | `CommonAccount` | `public void Login()` | `0x17C40B4` |
| dump.cs:37419 | `CommonAccount` | `public void LoginOut()` | `0x17C419C` |
| dump.cs:37422 | `CommonAccount` | `public string GetToken()` | `0x17C41A0` |
| dump.cs:37425 | `CommonAccount` | `public string GetLastError()` | `0x17C42CC` |
| dump.cs:37428 | `CommonAccount` | `public string GetAccountId()` | `0x17C42D4` |
| dump.cs:37431 | `CommonAccount` | `public bool IsLogin()` | `0x17C42DC` |
| dump.cs:37434 | `CommonAccount` | `public eLoginState GetState()` | `0x17C42E4` |
| dump.cs:37437 | `CommonAccount` | `public void .ctor()` | `0x17C3278` |

### `FacebookAccount` — out/recovered/dump.cs:37545–37584

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:37555 | `FacebookAccount` | `public void .ctor()` | `0x17C3170` |
| dump.cs:37558 | `FacebookAccount` | `public void Login()` | `0x17C4DC4` |
| dump.cs:37561 | `FacebookAccount` | `public void LoginOut()` | `0x17C4FFC` |
| dump.cs:37564 | `FacebookAccount` | `public string GetToken()` | `0x17C504C` |
| dump.cs:37567 | `FacebookAccount` | `public string GetAccountId()` | `0x17C5118` |
| dump.cs:37570 | `FacebookAccount` | `public string GetLastError()` | `0x17C51B8` |
| dump.cs:37573 | `FacebookAccount` | `public bool IsLogin()` | `0x17C51C0` |
| dump.cs:37576 | `FacebookAccount` | `public eLoginState GetState()` | `0x17C5210` |
| dump.cs:37579 | `FacebookAccount` | `public int onLogout(IntPtr L)` | `0x17C5218` |
| dump.cs:37583 | `FacebookAccount` | `private void <Login>b__4_0(ILoginResult result)` | `0x17C522C` |

### `FirebaseAccount` — out/recovered/dump.cs:37713–37754

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:37725 | `FirebaseAccount` | `public virtual void Login()` | `0x17C63D8` |
| dump.cs:37728 | `FirebaseAccount` | `protected void SetLoginState(eLoginState state)` | `0x17C6688` |
| dump.cs:37731 | `FirebaseAccount` | `public virtual void LoginOut()` | `0x17C67CC` |
| dump.cs:37734 | `FirebaseAccount` | `public string GetToken()` | `0x17C684C` |
| dump.cs:37737 | `FirebaseAccount` | `public string GetLastError()` | `0x17C68B4` |
| dump.cs:37740 | `FirebaseAccount` | `public string GetAccountId()` | `0x17C68BC` |
| dump.cs:37743 | `FirebaseAccount` | `public bool IsLogin()` | `0x17C68D0` |
| dump.cs:37746 | `FirebaseAccount` | `public eLoginState GetState()` | `0x17C68E0` |
| dump.cs:37749 | `FirebaseAccount` | `public void .ctor()` | `0x17C6380` |
| dump.cs:37753 | `FirebaseAccount` | `private void <Login>b__5_0(Task<FirebaseUser> task)` | `0x17C68E8` |

### `LoginManager` — out/recovered/dump.cs:1584–1697

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:1613 | `LoginManager` | `private void Start()` | `0x17298B4` |
| dump.cs:1616 | `LoginManager` | `public void InitSdk()` | `0x172AAB0` |
| dump.cs:1619 | `LoginManager` | `public void OnSdkInit()` | `0x172ADD0` |
| dump.cs:1622 | `LoginManager` | `private void CheckStartLogin()` | `0x172ADDC` |
| dump.cs:1625 | `LoginManager` | `public void TryOpenAnncouncementPanel()` | `0x172B020` |
| dump.cs:1628 | `LoginManager` | `private void StartLogin()` | `0x172ADEC` |
| dump.cs:1631 | `LoginManager` | `private void UpdateVersion()` | `0x172A854` |
| dump.cs:1634 | `LoginManager` | `private void OnDestroy()` | `0x172B75C` |
| dump.cs:1637 | `LoginManager` | `public void SwitchAccount()` | `0x172BB3C` |
| dump.cs:1640 | `LoginManager` | `public void CleanCache()` | `0x172BCA8` |
| dump.cs:1643 | `LoginManager` | `public void OpenCreditsPanel()` | `0x172BECC` |
| dump.cs:1646 | `LoginManager` | `private void Update()` | `0x172C0A4` |
| dump.cs:1649 | `LoginManager` | `private string GetCommonLoginStateTip(eLoginState loginState)` | `0x172C3F4` |
| dump.cs:1652 | `LoginManager` | `private string GetLoginStateTip(string loginPlatform, eLoginState loginState)` | `0x172C35C` |
| dump.cs:1655 | `LoginManager` | `public void StartLoading()` | `0x172C4CC` |
| dump.cs:1658 | `LoginManager` | `public void EndLoading()` | `0x172C614` |
| dump.cs:1661 | `LoginManager` | `public void Login(string login_platform)` | `0x172B5EC` |
| dump.cs:1664 | `LoginManager` | `public int OnLoginSuccess(IntPtr L)` | `0x172CB24` |
| dump.cs:1667 | `LoginManager` | `public int OnChangeServer(IntPtr L)` | `0x172D330` |
| dump.cs:1670 | `LoginManager` | `public int OnDisplayServerList(IntPtr L)` | `0x172D344` |
| dump.cs:1673 | `LoginManager` | `public int OnOpenAnncouncementPanel(IntPtr L)` | `0x172D3B8` |
| dump.cs:1676 | `LoginManager` | `public void EnterGame()` | `0x172CF54` |
| dump.cs:1679 | `LoginManager` | `private bool CheckContinueStage()` | `0x172D43C` |
| dump.cs:1682 | `LoginManager` | `public void LoadingOver()` | `0x172D660` |
| dump.cs:1685 | `LoginManager` | `public int OnLoginFailed(IntPtr L)` | `0x172D978` |
| dump.cs:1688 | `LoginManager` | `public void .ctor()` | `0x172DDDC` |
| dump.cs:1692 | `LoginManager` | `private void <InitSdk>b__23_0(int code, string msg)` | `0x172DDF0` |
| dump.cs:1696 | `LoginManager` | `private void <EnterGame>b__43_0()` | `0x172DE64` |

### `GameData` — out/recovered/dump.cs:15320–15532

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:15339 | `GameData` | `public string get_name()` | `0x19B9288` |
| dump.cs:15342 | `GameData` | `public static GameData get_empty()` | `0x19B9290` |
| dump.cs:15345 | `GameData` | `public void .ctor()` | `0x19AFF90` |
| dump.cs:15348 | `GameData` | `public void .ctor(string name)` | `0x19B92E8` |
| dump.cs:15351 | `GameData` | `public virtual void Set(string key, double value)` | `0x19B9314` |
| dump.cs:15354 | `GameData` | `public virtual void Set(string key, long value)` | `0x19B937C` |
| dump.cs:15357 | `GameData` | `public virtual void Set(string key, List<int> value)` | `0x19B93E4` |
| dump.cs:15360 | `GameData` | `public virtual void Set(string key, List<float> value)` | `0x19B96DC` |
| dump.cs:15363 | `GameData` | `public virtual void Set(string key, List<double> value)` | `0x19B99D4` |
| dump.cs:15366 | `GameData` | `public void Set(string key, string value)` | `0x19B9AA8` |
| dump.cs:15369 | `GameData` | `public void Set(string key, List<string> value)` | `0x19B9B10` |
| dump.cs:15372 | `GameData` | `public void Set(string key, bool value)` | `0x19B9BE4` |
| dump.cs:15375 | `GameData` | `public void Set(string key, GameData value)` | `0x19B9BF4` |
| dump.cs:15378 | `GameData` | `public void Set(string key, List<GameData> value)` | `0x19B9C5C` |
| dump.cs:15381 | `GameData` | `public virtual long GetLong(string key)` | `0x19B9D30` |
| dump.cs:15384 | `GameData` | `public virtual int GetInt(string key)` | `0x19B9D44` |
| dump.cs:15387 | `GameData` | `public virtual float GetFloat(string key)` | `0x19B9D58` |
| dump.cs:15390 | `GameData` | `public virtual double GetDouble(string key)` | `0x19B9D6C` |
| dump.cs:15393 | `GameData` | `public string GetString(string key)` | `0x19B0D04` |
| dump.cs:15396 | `GameData` | `public virtual bool GetBool(string key)` | `0x19B9E24` |
| dump.cs:15399 | `GameData` | `public GameData GetGameData(string key)` | `0x19AAD9C` |
| dump.cs:15402 | `GameData` | `public List<GameData> GetGameDataList(string key)` | `0x19B9E38` |
| dump.cs:15405 | `GameData` | `public virtual double GetDouble(string key, double defaultValue)` | `0x19B9ECC` |
| dump.cs:15408 | `GameData` | `public virtual float GetFloat(string key, float defaultValue)` | `0x19B9F70` |
| dump.cs:15411 | `GameData` | `public virtual long GetLong(string key, long defaultValue)` | `0x19BA048` |
| dump.cs:15414 | `GameData` | `public virtual int GetInt(string key, int defaultValue)` | `0x19BA12C` |
| dump.cs:15417 | `GameData` | `public virtual List<long> GetLongList(string key)` | `0x19BA210` |
| dump.cs:15420 | `GameData` | `public virtual List<int> GetIntList(string key)` | `0x19BA4F4` |
| dump.cs:15423 | `GameData` | `public virtual List<float> GetFloatList(string key)` | `0x19BA7D8` |
| dump.cs:15426 | `GameData` | `public string GetString(string key, string defaultValue)` | `0x19B9D80` |
| dump.cs:15429 | `GameData` | `public List<string> GetStringList(string key)` | `0x19BAAB8` |
| dump.cs:15432 | `GameData` | `public int GetStringListCount()` | `0x19BAB4C` |
| dump.cs:15435 | `GameData` | `public virtual bool GetBool(string key, bool defaultValue)` | `0x19BAB9C` |
| dump.cs:15438 | `GameData` | `public virtual double RemoveNumber(string key)` | `0x19BAC4C` |
| dump.cs:15441 | `GameData` | `public virtual List<double> RemoveNumberList(string key)` | `0x19BAD10` |
| dump.cs:15444 | `GameData` | `public string RemoveString(string key)` | `0x19BADD4` |
| dump.cs:15447 | `GameData` | `public List<string> RemoveStringList(string key)` | `0x19BAE98` |
| dump.cs:15450 | `GameData` | `public virtual bool RemoveBool(string key)` | `0x19BAF5C` |
| dump.cs:15453 | `GameData` | `public GameData RemoveGameData(string key)` | `0x19BB040` |
| dump.cs:15456 | `GameData` | `public List<GameData> RemoveGameDataList(string key)` | `0x19BB104` |
| dump.cs:15459 | `GameData` | `public virtual void Clear()` | `0x19B872C` |
| dump.cs:15462 | `GameData` | `public virtual void ForeachNumber(Action<string, double> func)` | `0x19BB1C8` |
| dump.cs:15465 | `GameData` | `public void ForeachString(Action<string, string> func)` | `0x19BB378` |
| dump.cs:15468 | `GameData` | `public void ForeachGameData(Action<string, GameData> func)` | `0x19BB52C` |
| dump.cs:15471 | `GameData` | `public virtual void ForeachNumberList(Action<string, List<double>> func)` | `0x19BB6E0` |
| dump.cs:15474 | `GameData` | `public void ForeachStringList(Action<string, List<string>> func)` | `0x19BB894` |
| dump.cs:15477 | `GameData` | `public void ForeachGameDataList(Action<string, List<GameData>> func)` | `0x19BBA48` |
| dump.cs:15480 | `GameData` | `public int GetGameDataCount()` | `0x19BBBFC` |
| dump.cs:15483 | `GameData` | `public int GetGameDataListCount()` | `0x19BBC4C` |
| dump.cs:15486 | `GameData` | `public int GetNumberCount()` | `0x19BBC9C` |
| dump.cs:15489 | `GameData` | `public int GetNumberListCount()` | `0x19BBCEC` |
| dump.cs:15492 | `GameData` | `public int GetStringCount()` | `0x19BBD3C` |
| dump.cs:15495 | `GameData` | `public string ToJson()` | `0x19BBD8C` |
| dump.cs:15498 | `GameData` | `public override string ToString()` | `0x19BC118` |
| dump.cs:15501 | `GameData` | `public GameData Copy(GameData gameData)` | `0x19BC4A0` |
| dump.cs:15504 | `GameData` | `public void FromString(string dataStr)` | `0x19BC774` |
| dump.cs:15507 | `GameData` | `public string ToBase64()` | `0x19BCAC4` |
| dump.cs:15510 | `GameData` | `public static GameData Parse(string dataStr)` | `0x19BCB58` |
| dump.cs:15513 | `GameData` | `public static GameData FromBase64(string dataStr)` | `0x19BCBB4` |
| dump.cs:15516 | `GameData` | `public static string Stringify(GameData gameData)` | `0x19BCCAC` |
| dump.cs:15519 | `GameData` | `public static bool op_LogicalNot(GameData value)` | `0x19AAD90` |
| dump.cs:15522 | `GameData` | `public static bool IsNullOrEmpty(GameData gameData)` | `0x19BCCC8` |
| dump.cs:15525 | `GameData` | `public static int Count(GameData gameData)` | `0x19BCD34` |
| dump.cs:15528 | `GameData` | `public virtual void ForeachIntList(Action<string, List<int>> func)` | `0x19BCF74` |
| dump.cs:15531 | `GameData` | `private static void .cctor()` | `0x19BD12C` |

### `LuaManager` — out/recovered/dump.cs:2100–2232

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:2123 | `LuaManager` | `public static LuaManager get_Instance()` | `0x1729D80` |
| dump.cs:2126 | `LuaManager` | `private void .ctor()` | `0x173467C` |
| dump.cs:2129 | `LuaManager` | `private static TextAsset loadLua(string file_path, string lua_path)` | `0x17348EC` |
| dump.cs:2132 | `LuaManager` | `private static byte[] LuaLoader(string script_path, ref string absoluteFn)` | `0x17349B8` |
| dump.cs:2135 | `LuaManager` | `public void AddErrorReport()` | `0x17347FC` |
| dump.cs:2138 | `LuaManager` | `public IntPtr GetState()` | `0x1734AF0` |
| dump.cs:2141 | `LuaManager` | `public bool IsLuaInited()` | `0x1734AF8` |
| dump.cs:2144 | `LuaManager` | `public bool GetGlobal(string name, out int result)` | `0x172B3E4` |
| dump.cs:2147 | `LuaManager` | `public bool GetGlobal(string name, out string result)` | `0x1734B18` |
| dump.cs:2150 | `LuaManager` | `public bool SetGlobal(string name, int param)` | `0x1734D50` |
| dump.cs:2153 | `LuaManager` | `public bool SetGlobal(string name, string param)` | `0x1734F18` |
| dump.cs:2156 | `LuaManager` | `public bool RunGlobalFunction(string name, int results, LuaRunCallback cb, object[] args)` | `0x172E750` |
| dump.cs:2159 | `LuaManager` | `public object RunGlobalTableFunction(string table_name, string name, object[] args)` | `0x172A314` |
| dump.cs:2162 | `LuaManager` | `public int GetLuaTop(IntPtr L)` | `0x17350E8` |
| dump.cs:2165 | `LuaManager` | `public bool RunGlobalTableFunction(IntPtr L, string table_name, string name, int results, LuaRunCallback cb, object[] args)` | `0x172C804` |
| dump.cs:2168 | `LuaManager` | `public bool RunGlobalTableFunctionWithEvent(IntPtr L, string table_name, string name, GameData gameData, string eventName)` | `0x173515C` |
| dump.cs:2171 | `LuaManager` | `public GameData RunGlobalTableFunGetResult(string table_name, string name, object[] args)` | `0x172B1B4` |
| dump.cs:2175 | `LuaManager` | `public static int OnRequestCallback(IntPtr L)` | `0x17341C0` |
| dump.cs:2178 | `LuaManager` | `public void RegistRequestCallback()` | `0x172C67C` |
| dump.cs:2181 | `LuaManager` | `public bool SendRequest(string group, string name, GameData gameData, CSCallback cb)` | `0x172D68C` |
| dump.cs:2184 | `LuaManager` | `public bool RunGlobalTableFunction(IntPtr L, string table_name, string name, int results, LuaRunCallback cb, string[] param)` | `0x1735398` |
| dump.cs:2187 | `LuaManager` | `public void RegistLuaEvent(string event_name, CSCallback cb)` | `0x1729E28` |
| dump.cs:2191 | `LuaManager` | `public static int OnLuaEvent(IntPtr L)` | `0x1734458` |
| dump.cs:2194 | `LuaManager` | `public int UnRegistLuaEvent(string event_name, CSCallback cb)` | `0x172B9F4` |
| dump.cs:2197 | `LuaManager` | `public void FireEvent(object game_object, string event_name, object[] args)` | `0x17356D8` |
| dump.cs:2200 | `LuaManager` | `public void FireEvent(string event_content)` | `0x172AC2C` |
| dump.cs:2203 | `LuaManager` | `public void FireEventWithGameData(string event_name, GameData event_data)` | `0x17359B8` |
| dump.cs:2206 | `LuaManager` | `public void ErrorReport(string error_msg)` | `0x1735C14` |
| dump.cs:2209 | `LuaManager` | `public object DoFile(string file_path)` | `0x1735C6C` |
| dump.cs:2212 | `LuaManager` | `public object DoString(string lua_str, string chunkname)` | `0x1735CC8` |
| dump.cs:2215 | `LuaManager` | `public int RegLuaGlobal(IntPtr L, string global_name)` | `0x1735D34` |
| dump.cs:2218 | `LuaManager` | `public void Start()` | `0x172EB5C` |
| dump.cs:2221 | `LuaManager` | `public void Loop(int frame)` | `0x1735E50` |
| dump.cs:2224 | `LuaManager` | `public void StepGC()` | `0x1735F70` |
| dump.cs:2227 | `LuaManager` | `private static void .cctor()` | `0x1735FCC` |
| dump.cs:2231 | `LuaManager` | `private void <Start>b__45_0()` | `0x1736220` |

### `WSHelper` — out/recovered/dump.cs:7724–7740

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:7733 | `WSHelper` | `public static int Connect(string host, int port)` | `0x19865D0` |
| dump.cs:7736 | `WSHelper` | `public static int Send(byte[] data)` | `0x198679C` |
| dump.cs:7739 | `WSHelper` | `public static int Close()` | `0x1986898` |

### `WSConnection` — out/recovered/dump.cs:7696–7720

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:7705 | `WSConnection` | `public void Init(string host, int port)` | `0x18783B0` |
| dump.cs:7708 | `WSConnection` | `private void Update()` | `0x1878488` |
| dump.cs:7712 | `WSConnection` | `public void Send(byte[] data)` | `0x187849C` |
| dump.cs:7716 | `WSConnection` | `public void Close()` | `0x187856C` |
| dump.cs:7719 | `WSConnection` | `public void .ctor()` | `0x1878620` |

### `Lua_WSHelper` — out/recovered/dump.cs:911–936

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:918 | `Lua_WSHelper` | `public static int Connect_s(IntPtr l)` | `0x17260C8` |
| dump.cs:923 | `Lua_WSHelper` | `public static int Send_s(IntPtr l)` | `0x1726238` |
| dump.cs:928 | `Lua_WSHelper` | `public static int Close_s(IntPtr l)` | `0x172639C` |
| dump.cs:932 | `Lua_WSHelper` | `public static void reg(IntPtr l)` | `0x17264C4` |
| dump.cs:935 | `Lua_WSHelper` | `public void .ctor()` | `0x172667C` |

### `CurrencyAmount` — out/recovered/dump.cs:596329–596364

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:596344 | `CurrencyAmount` | `internal void .ctor(string amount, string currency)` | `0x1A9DCF8` |
| dump.cs:596348 | `CurrencyAmount` | `public string get_Amount()` | `0x1A9DD3C` |
| dump.cs:596352 | `CurrencyAmount` | `private void set_Amount(string value)` | `0x1A9DD44` |
| dump.cs:596356 | `CurrencyAmount` | `public string get_Currency()` | `0x1A9DD4C` |
| dump.cs:596360 | `CurrencyAmount` | `private void set_Currency(string value)` | `0x1A9DD54` |
| dump.cs:596363 | `CurrencyAmount` | `public override string ToString()` | `0x1A9DD5C` |

## 5. Login-service candidates, kept separate from the grep hits above

These are not matches of the three commands in section 1; they are the service-side login classes found earlier, listed because `LoginPanel` and `LoginUI` are UI.

| file:line | Class | Method | RVA |
|---|---|---|---|
| dump.cs:37330 | `AccountMgr : Singleton<AccountMgr>` | `public void Login(string login_platform)` | `0x17C2F78` |
| dump.cs:37333 | `AccountMgr` | `public bool IsLogin()` | `0x17C32D0` |
| dump.cs:37339 | `AccountMgr` | `public string GetToken()` | `0x17C3444` |
| dump.cs:37342 | `AccountMgr` | `public eLoginState GetLoginState()` | `0x17C34F4` |
| dump.cs:37845 | `IAccount` (interface) | `public abstract bool IsLogin()` | `-1` (interface slot, no code) |
| dump.cs:37431 | `CommonAccount : IAccount` | `public bool IsLogin()` | `0x17C42DC` |
| dump.cs:37434 | `CommonAccount` | `public eLoginState GetState()` | `0x17C42E4` |
| dump.cs:37573 | `FacebookAccount : IAccount` | `public bool IsLogin()` | `0x17C51C0` |
| dump.cs:37743 | `FirebaseAccount : IAccount` | `public bool IsLogin()` | `0x17C68D0` |
| dump.cs:37728 | `FirebaseAccount` | `protected void SetLoginState(eLoginState state)` | `0x17C6688` |
| dump.cs:1664 | `LoginManager : MonoBehaviour` | `public int OnLoginSuccess(IntPtr L)` | `0x172CB24` |
| dump.cs:1676 | `LoginManager` | `public void EnterGame()` | `0x172CF54` |

`AccountMgr` holds a single `IAccount m_Account` field (dump.cs:37322). The state enum is at dump.cs:37307: `eLoginState { READY_TO_LOGIN=0, APPLY_TOKEN=1, VERIFY_TOKEN=2, LOGIN_COMPLETE=3, LOGIN_FAILED=4 }`.

## 6. Limits of this evidence

- These patterns found no game-balance getter in `dump.cs`. That is a statement about these patterns, not proof that no balance accessor exists anywhere in the build: a differently named member, a Lua-side value, or a field read with no accessor would not match.
- The dump carries declarations, signatures and RVAs only, with no method bodies. Which of `AccountMgr.IsLogin` or the three `IAccount` implementations actually calls the server, and which one the UI gates on, cannot be established from declarations; that needs the disassembly at those RVAs or a runtime trace.
- `IAccount` members report `RVA: -1` because an interface slot has no code; the per-class RVAs above are the real addresses.
