// The primitive facade: one object per agent with every primitive bound to its Ctx. This is what
// the shell, the reflexes, the MCP tools and (later) the Shem interpreter call.
import type { Ctx } from "./context.ts";
import { withToken } from "./context.ts";
import type { CancelToken } from "./errors.ts";
import * as actions from "./actions.ts";
import * as chat from "./chat.ts";
import * as inv from "./inventory.ts";
import * as look from "./look.ts";
import * as nav from "./nav.ts";
import * as perception from "./perception.ts";

type Tail<T extends (ctx: Ctx, ...a: any[]) => any> = T extends (ctx: Ctx, ...a: infer A) => infer R ? (...a: A) => R : never;

function bind<F extends (ctx: Ctx, ...a: any[]) => any>(ctx: Ctx, f: F): Tail<F> {
  return ((...a: any[]) => f(ctx, ...a)) as Tail<F>;
}

export function makePrimitives(ctx: Ctx) {
  return {
    ctx,
    with(token: CancelToken) { return makePrimitives(withToken(ctx, token)); },
    // perception
    blockAt: bind(ctx, perception.blockAt),
    findBlocks: bind(ctx, perception.findBlocks),
    entities: bind(ctx, perception.entities),
    threats: bind(ctx, perception.threats),
    nearestEntity: bind(ctx, perception.nearestEntity),
    entityById: bind(ctx, perception.entityById),
    players: bind(ctx, perception.players),
    lookAround: bind(ctx, perception.lookAround),
    target: bind(ctx, perception.target),
    chatHistory: bind(ctx, perception.chatHistory),
    inventory: bind(ctx, inv.inventory),
    selectItem: bind(ctx, inv.selectItem),
    bestTool: bind(ctx, inv.bestTool),
    bestFood: bind(ctx, inv.bestFood),
    // movement
    goto: bind(ctx, nav.goto),
    gotoXZ: bind(ctx, nav.gotoXZ),
    gotoNearestBlock: bind(ctx, nav.gotoNearestBlock),
    follow: bind(ctx, nav.follow),
    stop: bind(ctx, nav.stop),
    move: bind(ctx, nav.move),
    jump: bind(ctx, nav.jump),
    flee: bind(ctx, nav.flee),
    surface: bind(ctx, nav.surface),
    explore: bind(ctx, nav.explore),
    mineAll: bind(ctx, nav.mineAll),
    baritone: bind(ctx, nav.baritone),
    navCheck: bind(ctx, nav.navCheck),
    lookAt: bind(ctx, look.lookAt),
    // actions
    mine: bind(ctx, actions.mine),
    shootAt: bind(ctx, actions.shootAt),
    shootStatic: bind(ctx, actions.shootStatic),
    pearlTo: bind(ctx, actions.pearlTo),
    meleeWhile: bind(ctx, actions.meleeWhile),
    combatStop: bind(ctx, actions.combatStop),
    digDown: bind(ctx, actions.digDown),
    place: bind(ctx, actions.place),
    placeNearby: bind(ctx, actions.placeNearby),
    useOnBlock: bind(ctx, actions.useOnBlock),
    useItem: bind(ctx, actions.useItem),
    interactEntity: bind(ctx, actions.interactEntity),
    attack: bind(ctx, actions.attack),
    equip: bind(ctx, actions.equip),
    useHold: bind(ctx, actions.useHold),
    useRelease: bind(ctx, actions.useRelease),
    shoot: bind(ctx, actions.shoot),
    eat: bind(ctx, actions.eat),
    drop: bind(ctx, actions.drop),
    respawn: bind(ctx, actions.respawn),
    openContainer: bind(ctx, actions.openContainer),
    container: bind(ctx, actions.container),
    closeScreen: bind(ctx, actions.closeScreen),
    deposit: bind(ctx, actions.deposit),
    withdraw: bind(ctx, actions.withdraw),
    craft: bind(ctx, actions.craft),
    recipes: bind(ctx, actions.recipes),
    craftable: bind(ctx, actions.craftable),
    map: bind(ctx, actions.map),
    screenshot: bind(ctx, actions.screenshot),
    collectDrops: bind(ctx, actions.collectDrops),
    smelt: bind(ctx, actions.smelt),
    sleepInBed: bind(ctx, actions.sleepInBed),
    // speech
    say: bind(ctx, chat.say),
    whisper: bind(ctx, chat.whisper),
  };
}

export type Primitives = ReturnType<typeof makePrimitives>;
