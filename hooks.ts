// hooks.ts — hook scaffold for Swordash. Build: npx frida-compile hooks.ts -o libgadget.js
// Fill in the real class/method names from the Phase 2 table, then uncomment each block.
import "frida-il2cpp-bridge";

const LOG = (m: string) => console.log(`[sw] ${m}`);

function img() {
  // Change "Assembly-CSharp" if the dump shows another assembly (Assembly-CSharp-firstpass, etc.)
  return Il2Cpp.domain.assembly("Assembly-CSharp").image;
}

function hookGet(cls: string, method: string, value: any) {
  try {
    const c = img().class(cls);
    c.method(method).implementation = function () {
      LOG(`${cls}.${method} -> ${value}`);
      return value;
    };
    LOG(`hooked ${cls}.${method}`);
  } catch (e) {
    LOG(`FAIL ${cls}.${method}: ${e}`);
  }
}

function hookTrue(cls: string, method: string) {
  try {
    const c = img().class(cls);
    c.method(method).implementation = function () {
      LOG(`${cls}.${method} -> true`);
      return true;
    };
    LOG(`hooked ${cls}.${method}`);
  } catch (e) {
    LOG(`FAIL ${cls}.${method}: ${e}`);
  }
}

Il2Cpp.perform(() => {
  const BIG = 999999999;

  // ---- Phase 3: bypass login ----
  // TODO: replace with the real class/method found in Phase 2
  // hookTrue("AuthManager", "get_IsLoggedIn");
  // hookTrue("SessionManager", "HasSession");
  // hookTrue("LoginManager", "IsSignedIn");

  // ---- Phase 4: full resources (hook the GETTERS) ----
  // TODO: cast via Il2Cpp.int64 / int32 if the getter returns a numeric type
  // hookGet("UserData", "get_Gems", BIG);
  // hookGet("UserData", "get_Coins", BIG);
  // hookGet("UserData", "get_Zeno", BIG);

  // ---- Phase 5: network mock ----
  // Option A (preferred) — hook the game's own client function.
  // TODO:
  // const api = img().class("ApiClient");
  // api.method("Send").implementation = function (req: any) {
  //   const url = req.toString();
  //   LOG(`NET ${url}`);
  //   // return canned JSON keyed on the url, e.g.:
  //   // if (url.includes("/login")) return '{"uid":1,"token":"x"}';
  //   return null;
  // };

  // Option B — hook UnityEngine.Networking.UnityWebRequest if no ApiClient exists.
  // Option C — intercept at socket level: hook libc `connect` and redirect to localhost.

  LOG("hooks loaded");
});
