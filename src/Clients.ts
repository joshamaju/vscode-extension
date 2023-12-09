import * as Domain from "@effect/experimental/DevTools/Domain"
import * as Server from "@effect/experimental/DevTools/Server"
import * as SocketServer from "@effect/experimental/SocketServer/Node"
import {
  Context,
  Effect,
  Fiber,
  HashSet,
  Layer,
  Option,
  Queue,
  ReadonlyArray,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect"
import { executeCommand, registerCommand } from "./VsCode"

export interface Client {
  readonly id: number
  readonly spans: Queue.Dequeue<Domain.Span>
}

const make = Effect.gen(function* (_) {
  const server = yield* _(Server.make)
  const clients = yield* _(SubscriptionRef.make(HashSet.empty<Client>()))
  const activeClient = yield* _(SubscriptionRef.make(Option.none<Client>()))
  let clientId = 1

  yield* _(
    registerCommand("effect.selectClient", (id: number) =>
      Effect.gen(function* (_) {
        const current = yield* _(SubscriptionRef.get(clients))
        const client = ReadonlyArray.findFirst(current, _ => _.id === id)
        if (client._tag === "None") {
          return
        }
        yield* _(SubscriptionRef.set(activeClient, client))
      }),
    ),
  )

  const take = Effect.gen(function* (_) {
    const queue = yield* _(server.clients.take)
    const spans = yield* _(
      Effect.acquireRelease(Queue.sliding<Domain.Span>(100), Queue.shutdown),
    )
    const client: Client = {
      id: clientId++,
      spans,
    }
    yield* _(
      Effect.acquireRelease(
        SubscriptionRef.update(clients, HashSet.add(client)),
        () =>
          Effect.zipRight(
            SubscriptionRef.update(clients, HashSet.remove(client)),
            SubscriptionRef.update(
              activeClient,
              Option.filter(_ => _ !== client),
            ),
          ),
      ),
    )
    yield* _(
      SubscriptionRef.update(
        activeClient,
        Option.orElse(() => Option.some(client)),
      ),
    )

    return yield* _(
      queue.take,
      Effect.flatMap(_ => spans.offer(_)),
      Effect.forever,
    )
  }).pipe(Effect.scoped, Effect.fork, Effect.forever)

  const run = server.run.pipe(
    Effect.catchAllCause(Effect.log),
    Effect.repeat(Schedule.spaced("10 seconds")),
    Effect.forever,
    Effect.zipLeft(take, { concurrent: true }),
    Effect.fork,
  )

  const running = yield* _(SubscriptionRef.make(false))
  let fiber: Fiber.RuntimeFiber<never, never> | undefined
  yield* _(
    running.changes,
    Stream.runForEach(running =>
      Effect.gen(function* (_) {
        yield* _(executeCommand("setContext", "effect:running", running))
        if (running) {
          if (!fiber) {
            fiber = yield* _(run)
          }
        } else if (fiber) {
          yield* _(Fiber.interrupt(fiber))
          fiber = undefined
        }
      }),
    ),
    Effect.forkScoped,
  )

  yield* _(
    registerCommand("effect.startServer", () =>
      SubscriptionRef.set(running, true),
    ),
  )

  yield* _(
    registerCommand("effect.stopServer", () =>
      SubscriptionRef.set(running, false),
    ),
  )

  return { clients, activeClient, running } as const
})

export interface Clients {
  readonly _: unique symbol
}
export const Clients = Context.Tag<Clients, Effect.Effect.Success<typeof make>>(
  "effect-vscode/Clients",
)
export const ClientsLive = Layer.scoped(Clients, make).pipe(
  Layer.provide(SocketServer.layerWebSocket({ port: 34437 })),
)
