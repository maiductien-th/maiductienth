# Offline reward path: decoded evidence (working notes)

Sources: decompiled TextAssets from this build (`battle_module`, `economic_module`, `equip_module`, `aim_module`, `config_mgr`, `proto_def`) and decoded CSV configs (`guide`, `aim`, `item`, `drop_group`, `reward_pool`, `box`).

## How the tutorial gear is granted
- Not a room drop. `drop_group` has only `sm_1 boss pool_stone` for stage 1-1.
- `aim` config row 1: target `passStage 1`, reward `box1_1|1`.
- Guide `guide_open_aim_*` finishes on `AIM.CLAIM_REWARD`; `guide_use_item_*` requires `item:box1_1`; `guide_equip_0` requires `heroLevelLT:1|equipingLT:0` and `guide_equip_4` finishes on `EQUIP.EQUIP`.
- So the chain is `AIM.CLAIM_REWARD {index}` -> box1_1 in inventory -> `ITEM.USE {item_id,item_index,use_count}` -> equipment in `EQUIP.el` -> `EQUIP.EQUIP`.
- box1_1 ("Rookie Box #1", a timed box) contents are in the client `realitem` config (`UseReward` column): `coin|500;stone|5;gift_equip|1|Equipment_Weapon_Frontline_Tachi;box1_2|1`. box1_2 grants the armor and ornament pieces the same way, so the rookie-box chain can be resolved locally from config.
- `realitem` columns: `id, sortOrder, maxCount, lifeTime, UseCondition, UseReward, Condition`; real id 1 is box1_1.
- `equipment` config: `Equipment_Weapon_Frontline_Tachi` has numeric id 101; ULT discs start at 501 (`Equipment_Disc_SpaceJudgement_A`).

## Response shapes the callers read
- `AIM.CLAIM_REWARD` callback: `ret_code == 1`, then fires `AIM.CLAIM_REWARD(index)` and `ON_GET_ITEMS(response.reward)`.
- `ITEM.USE` callback: `ret_code == 1`, then `table.show(response.reward)`.
- proto `.item { id 0: string, count 1: integer, args 2: string }`.

## Inventory storage
- `ECO.d`: Economic items, wire-keyed by `item.index`, mapped back via `economic_index2key`.
- `ECO.t`: list of `{packed, n}`; `packed` is parsed by `ParseItemValue(v) = ((v >> 7) & 511, v & 127)`, resolved through `ConfigMgr:GetItemIdByRealItemId` / `GetRealItemConfig`.
- `EQUIP.el`: keyed by euid; entries use the `equipment` DataEnum keys `base_value, distribution, attr_list, uuid, link, pet, grade_data, skill_list, energy`. `base_value` packs template id `(v >> 16) & TEMPLATE_ID_MASK`, level `(v >> 8) & 255`, stars `v & 255`, plus new/lock mask bits.

## Room drops
- `BattleModule:GetDropItemInfoForCS(room_id)` reads `BATTLE.data[room_id]`: `tag -> list of {index, {item_id = count | drop_equip = {params...}}}`; C# `LoadDropItemInfoFromLua(roomId)` consumes it.
- Room config `drop_tag_list` (e.g. `m2_1 = {normal: 5}`), `drop_group` maps `stage + tag -> dropPool, probability`.

## Still to trace (implementation order)
1. `AIM.CLAIM_REWARD {index}`: set `AIM.ca`/`cr` bit, add `box1_1` to `ECO.t`, return `{ret_code=1, reward={{id="box1_1",count=1}}}`.
2. `ITEM.USE {item_id,item_index,use_count}`: remove the `ECO.t` entry, grant the `realitem.UseReward` list (Economic into `ECO.d`, `gift_equip` into `EQUIP.el` with a new `euid`, boxes into `ECO.t`).
3. The request behind the guide's `EQUIP.EQUIP` event (proto `SET_EQUIP {euid, ...}` sits near the GUIDE section of `proto_def`).
4. Verify `EQUIP.el` entry encoding round-trips through `encode(..., key_enum)`; log `EquipModule:GetEquipList()` after sync.
