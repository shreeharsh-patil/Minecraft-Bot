# Retained source inventory

Baseline commit: `e8a503aa878a1714a89936a098e2988be6ef71ac`. Generated from every tracked original file. SHA-256 allows auditing that original content was retained. Module mappings describe implementation locations; they do not assert behavioral or live-server parity. See [migration gates](migration.md).

- `.env.example` — SHA-256 `b57550fb4cb6ad8d34aa7c5dfff9eb787cb3ad4215ded0bb829b818f9df50827`; retained original configuration/dependency/test tooling.

- `.gitignore` — SHA-256 `210b012ce0d1c2ba442836ea3ba2af5b542375fb0f6feca5b3a0698830e92a2f`; retained original configuration/dependency/test tooling.

- `README.md` — SHA-256 `80240b8e7493cc954defa97ec66e79baf267cf7cbc39c4cde81df5f89925ac75`; retained original configuration/dependency/test tooling.

- `eslint.config.js` — SHA-256 `5b54815e45b1f7946173de9323d78af4fb72b86ea57801f74606ea497ec0d020`; retained original configuration/dependency/test tooling.

- `package-lock.json` — SHA-256 `a5123c519798c34a2c407a45a8a23b8cad265c5385afd826f8b2c8b85db093d9`; retained original configuration/dependency/test tooling.

- `package.json` — SHA-256 `307523dfd0f823a737b1db72a4cff3a12c5139921369a473f5baf313281462c2`; retained original configuration/dependency/test tooling.

## `src/ai/AIManager.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `AIManagerOptions`, `AIManagerStats`, `AIManager`.

Methods/algorithms: `plan`, `planDetailed`, `cancelAll`, `stats`, `dispose`, `acquire`, `makeRelease`, `removeFromQueue`, `linkSignals`.

SHA-256: `64ae96303fbaeed7dcaa1fe535ab38330d9ed6cd8e1e1b91b95cf1f9a3ae2f9e`.

## `src/ai/contextBuilder.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `WorldContextSource`, `ContextMemorySource`, `ContextLimits`, `DEFAULT_CONTEXT_LIMITS`, `CompactContext`, `ContextBuilderOptions`, `buildCompactContext`.

Methods/algorithms: `getHealth`, `getHunger`, `scanNearbyBlocks`, `getInventory`.

SHA-256: `2d07eecffac2a1d7d97d324396f68c44888dc5e2db249dd4f89b45f8109b925b`.

## `src/ai/index.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: (re-exports only).

Methods/algorithms: (module functions listed above).

SHA-256: `ede07494731279e8f14f9ecc39fa286d3179c1a270020caf6c4abe5d07d549e1`.

## `src/ai/memory.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `MAX_CONVERSATION_TURNS`, `MemoryStoreOptions`, `InMemoryMemoryStore`, `createMemoryStore`.

Methods/algorithms: `noteInstruction`, `noteFailure`, `noteConversation`, `setObjective`, `setTargetPlayer`, `rememberLocation`, `recallLocation`, `listLocations`, `setPreference`, `getPreference`, `isTrusted`, `addTrusted`, `snapshot`, `reset`, `persist`, `load`.

SHA-256: `579cc73768e35b34c19eb508fce57a24df70a49715e4cf4de1f1a61490372c8e`.

## `src/ai/planner.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `PlannerOptions`, `PlanRequest`, `PlanResult`, `parseActions`, `parseResponse`, `buildSystemPrompt`, `buildUserMessage`, `Planner`.

Methods/algorithms: `plan`.

SHA-256: `efbc4bf73d01d91cb046d34d3eef0f65bc7be93c7a5a8f8bc47e76906d464d39`.

## `src/ai/providers/BaseProvider.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `ProviderUsage`, `WireResult`, `BaseProviderOptions`, `asRecord`, `asString`, `asNumber`, `readUsage`, `BaseProvider`, `errorName`, `errorMessage`, `errorCode`, `safeUrl`, `stripCodeFences`, `extractBalancedJson`, `extractJson`.

Methods/algorithms: `isAvailable`, `healthCheck`, `dispose`, `complete`, `transportError`, `httpError`, `summarizeErrorBody`.

SHA-256: `2e62c85e27d5ff68d796a63966c58b5a28c64fc8c4cffc2a3140297c441a1dea`.

## `src/ai/providers/GeminiProvider.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `GEMINI_BASE_URL`, `GEMINI_DEFAULT_MODEL`, `GeminiProviderOptions`, `GeminiProvider`.

Methods/algorithms: (module functions listed above).

SHA-256: `6236c9d2fdec3a8dc8f7f0bfb61e8dd418888b0a67109f5d9e4c2a7e6d6b011e`.

## `src/ai/providers/GroqProvider.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `GROQ_BASE_URL`, `GROQ_DEFAULT_MODEL`, `GroqProviderOptions`, `GroqProvider`.

Methods/algorithms: (module functions listed above).

SHA-256: `7bcd33d6207910bd42f5ed33a1d195747c310e945c104a2748bbbfa103ab4c6e`.

## `src/ai/providers/OpenAIProvider.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `OPENAI_BASE_URL`, `OPENAI_DEFAULT_MODEL`, `OpenAIProvider`.

Methods/algorithms: (module functions listed above).

SHA-256: `b92481b9e1b2d18d89cbc80c20bf7de87697190b6f3e162ad36533b40cb9f52d`.

## `src/ai/providers/OpenAiCompatibleProvider.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `OpenAiCompatibleOptions`, `OpenAiCompatibleProvider`.

Methods/algorithms: (module functions listed above).

SHA-256: `b4c97ea40faf9039d6ddef9485218859840b4a0436fd2f368ef103ffdea33daa`.

## `src/ai/providers/OpenRouterProvider.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`, `OpenRouterProviderOptions`, `OpenRouterProvider`.

Methods/algorithms: (module functions listed above).

SHA-256: `c946ec54275ca6a8ebf97f3d968c9f4d7c79538ff55fe0e8ec457dba93b2bbeb`.

## `src/ai/providers/ProviderPool.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `CircuitState`, `ProviderPoolOptions`, `ProviderPool`.

Methods/algorithms: `register`, `get`, `has`, `all`, `getAvailable`, `circuitState`, `recordSuccess`, `recordFailure`, `stats`, `statsFor`, `disposeAll`, `refreshCircuit`, `ema`.

SHA-256: `51b6b825de699f8c2646c08b6149161bb413abb00819c6d4bc91496573e2c0fc`.

## `src/ai/router.ts`

Rust: native/src/ai.rs (Manager, AiProvider, HttpProvider, Request); native/src/memory.rs (Memory)

Public declarations: `AIRouterOptions`, `RoutedResult`, `AIUnavailableError`, `AIRouter`.

Methods/algorithms: `complete`, `attemptBudget`, `rank`, `toProviderError`.

SHA-256: `1dce45f55f2b827dea4cbfc3fe6a24a921d2a66f5db7270c405f04c186ecf81f`.

## `src/bot/createBot.ts`

Rust: native/src/minecraft/mod.rs (EcsRunner, authenticate, connect_with_config, session, run); game.rs (NativeGame); lifecycle.rs (Presence)

Public declarations: `ConnectedBot`, `CreateBotOptions`, `createBot`.

Methods/algorithms: (module functions listed above).

SHA-256: `94cb5dd52773e08fe70da1ca267f52215bc8224f6391f18a1a0dec8eaa0efdd3`.

## `src/bot/events.ts`

Rust: native/src/minecraft/mod.rs (EcsRunner, authenticate, connect_with_config, session, run); game.rs (NativeGame); lifecycle.rs (Presence)

Public declarations: `BotEventHandlers`, `WireOptions`, `wireBotEvents`.

Methods/algorithms: (module functions listed above).

SHA-256: `57c297c378e4157bc4c08543760126631b2861dc25e9052509f00e646fee7677`.

## `src/bot/humanPresence.ts`

Rust: native/src/minecraft/mod.rs (EcsRunner, authenticate, connect_with_config, session, run); game.rs (NativeGame); lifecycle.rs (Presence)

Public declarations: `PresenceReason`, `PresenceVerdict`, `HumanPresenceMonitor`.

Methods/algorithms: `setDisconnectHandler`, `start`, `stop`, `check`, `noteDisconnected`, `getLastHumanSeen`, `markHumanSeen`, `resetGreetings`, `getVerdict`, `remember`.

SHA-256: `f412da3ddb5eae6cbcae0efd43de3c0b6d9293b3923fb5211e622fa45fe5c32b`.

## `src/bot/mineflayerFacade.ts`

Rust: native/src/minecraft/mod.rs (EcsRunner, authenticate, connect_with_config, session, run); game.rs (NativeGame); lifecycle.rs (Presence)

Public declarations: `MineflayerFacade`.

Methods/algorithms: `getDimension`, `getPosition`, `getHealth`, `getHunger`, `isOnGround`, `getTimeOfDay`, `getEntityId`, `getBlockAt`, `isDangerous`, `findNearestBlock`, `findBlocks`, `scanNearbyBlocks`, `toBlockRef`, `getNearbyPlayers`, `resolvePlayerName`, `getNearbyEntities`, `getNearestPlayer`, `findNearestChest`, `getNearbyDroppedItems`, `getInventory`, `countItem`, `heldItem`, `freeSlots`, `itemId`, `itemMeta`, `moveToPosition`, `moveToPlayer`, `stopMoving`, `getGoal`, `lookAt`, `getPathfinder`, `equipItem`, `digBlock`, `attackEntity`, `useItem`, `eat`, `dropItem`, `depositIntoChest`, `withdrawFromChest`, `openWindow`, `selectToolFor`, `chat`, `items`.

SHA-256: `a645f3733c2080c778db712a8d4f794b426ec27416e5665a2ce865d290ee2c48`.

## `src/bot/reconnect.ts`

Rust: native/src/minecraft/mod.rs (EcsRunner, authenticate, connect_with_config, session, run); game.rs (NativeGame); lifecycle.rs (Presence)

Public declarations: `ReconnectPolicy`, `ReconnectContext`, `ReconnectOutcome`, `isFatalDisconnect`, `reconnect`, `policyFrom`.

Methods/algorithms: (module functions listed above).

SHA-256: `87a3114c35adf504890deb00f10dd2b655695cadacc8be0bf4b4550cbb769731`.

## `src/chat/chatListener.ts`

Rust: native/src/chat.rs (Input, parse, HELP); native/src/minecraft/mod.rs (session); native/src/safety.rs (chat_reply)

Public declarations: `ChatMessage`, `ChatRoute`, `ChatListenerDeps`, `ChatListener`.

Methods/algorithms: `route`, `handle`.

SHA-256: `088d0ad12752eee7ff7d242c2ed3c81ed02c9cd8128fe52f9ec2910a50e04776`.

## `src/chat/commandParser.ts`

Rust: native/src/chat.rs (Input, parse, HELP); native/src/minecraft/mod.rs (session); native/src/safety.rs (chat_reply)

Public declarations: `ParsedCommand`, `ParseResult`, `parseInput`, `parseInteger`, `parseIntegers`, `parsePlayerName`, `parseCount`, `toAction`, `COMMAND_SYNTAX`, `DETERMINISTIC_COMMANDS`, `LOCAL_COMMANDS`, `parseLocationName`.

Methods/algorithms: (module functions listed above).

SHA-256: `d8fd67183ab268e064008531c8275ffdf5a40b7b0b886099aa758651c11ddb42`.

## `src/chat/responses.ts`

Rust: native/src/chat.rs (Input, parse, HELP); native/src/minecraft/mod.rs (session); native/src/safety.rs (chat_reply)

Public declarations: `ChatResponder`, `formatHelp`, `formatInventory`, `formatStatus`, `formatProviders`, `formatResult`.

Methods/algorithms: `send`, `announce`, `drain`, `clear`.

SHA-256: `a2388fcee0d6b4db4fc1923599c908ba26d8b5d30d7ebb28342e6d7d109c53d2`.

## `src/commands/index.ts`

Rust: native/src/chat.rs (parse, HELP); native/src/minecraft/mod.rs (session)

Public declarations: `LocalCommandDeps`, `LocalCommands`.

Methods/algorithms: `handle`, `status`, `inventory`, `distanceTo`.

SHA-256: `e27c7ab080d8668dee771e675f1534b320c11525a2b837ac240ce8502ac9ffb5`.

## `src/config/config.ts`

Rust: native/src/config.rs (Config, ProviderConfig); native/src/safety.rs (FOODS, hostile, dangerous)

Public declarations: `MinecraftConfig`, `AiProviderConfig`, `AiConfig`, `ChatConfig`, `PresenceConfig`, `SafetyConfig`, `RuntimeConfig`, `AppConfig`, `ConfigError`, `Env`, `str`, `int`, `bool`, `oneOf`, `csv`, `buildConfig`, `loadConfig`, `isAuthorized`, `defaultTestEnv`.

Methods/algorithms: (module functions listed above).

SHA-256: `4dbf0d6f47f6de7fd4422c48f5e6cc8f18fd2c824a0d626158947fc15f92aee1`.

## `src/config/constants.ts`

Rust: native/src/config.rs (Config, ProviderConfig); native/src/safety.rs (FOODS, hostile, dangerous)

Public declarations: `DEFAULT_BOT_PREFIX`, `ACTION_TYPES`, `CONFLICT_GROUP`, `DANGEROUS_BLOCKS`, `HOSTILE_MOB_FAMILIES`, `BLOCK_TOOL`, `SOFT_BLOCKS`, `FOODS`, `MOVEMENT`, `BOT_TIMING`, `PROVIDER_NAMES`, `ProviderName`.

Methods/algorithms: (module functions listed above).

SHA-256: `fe7388cf4e86cc3758a5ec8bd081c3d5641f78dbe4fdc852e6a43098a7f36a35`.

## `src/executor/actionExecutor.ts`

Rust: native/src/actions.rs (Action::validate, parse_plan); native/src/executor.rs (Scheduler, Job, Work)

Public declarations: `ActionExecutorDeps`, `PlanOutcome`, `ActionExecutor`.

Methods/algorithms: `runPlan`, `cancelActivePlan`, `hasActivePlan`.

SHA-256: `8705e8f560e7c32b57ed147230a00a3ef197fbfc9ce38c19205b5456865c7a01`.

## `src/executor/actionQueue.ts`

Rust: native/src/actions.rs (Action::validate, parse_plan); native/src/executor.rs (Scheduler, Job, Work)

Public declarations: `TaskExecutionContext`, `TaskHandle`, `TaskManager`.

Methods/algorithms: `setSettleListener`, `start`, `onCleanup`, `cancel`, `pause`, `resume`, `setPlanning`, `cancelGroup`, `cancelAll`, `activeTask`, `list`, `prune`, `release`.

SHA-256: `ff5c4942fb156379b3490a54cef76cc635bd3568b7e874167ea1e25f7c0095dc`.

## `src/executor/validator.ts`

Rust: native/src/actions.rs (Action::validate, parse_plan); native/src/executor.rs (Scheduler, Job, Work)

Public declarations: `ValidationResult`, `validateAction`, `PlanValidationResult`, `validatePlan`.

Methods/algorithms: (module functions listed above).

SHA-256: `5cc6b8d09f658f04bf9407b445e8dd8c0ec2d87a634018755aa623a6b0f6f11a`.

## `src/index.ts`

Rust: None

Public declarations: `BotApp`.

Methods/algorithms: `start`, `connect`, `runDeterministic`, `handleNaturalLanguage`, `stopEverything`, `say`, `onDisconnected`, `shutdown`.

SHA-256: `2bd9d3d90f6815439f887918a5fc9bb47d45890c673c8a3b427e38e94df22385`.

## `src/safety/actionLimits.ts`

Rust: native/src/safety.rs (Authorization, RateLimit, protected, region_protected, sensitive, redact); native/src/minecraft/game.rs (safe_break)

Public declarations: `LimitDecision`, `DEFAULT_MAX_MINE`, `DEFAULT_MAX_BUILD`, `DEFAULT_MAX_WAIT_MS`, `MAX_PLANNED_ACTIONS`, `MAX_DROP_COUNT`, `MAX_BUILD_DIMENSION`, `ActionLimits`.

Methods/algorithms: `checkRate`, `clampMineCount`, `clampBuildCount`, `recordMining`, `recordBuilding`, `resetTaskCounters`, `checkAction`, `snapshot`.

SHA-256: `59e21ce15399d526958280ae357ac935884c1435fecae95ef303a353a507beb7`.

## `src/safety/antiGrief.ts`

Rust: native/src/safety.rs (Authorization, RateLimit, protected, region_protected, sensitive, redact); native/src/minecraft/game.rs (safe_break)

Public declarations: `AntiGriefContext`, `AntiGriefDecision`, `AntiGriefRules`.

Methods/algorithms: `canOpenChest`, `shouldYieldToPlayer`, `canPlaceBlock`.

SHA-256: `3c6bed751554a3fbb2518db5febf1d3aa1c483b30e886466ed3bc11a0c04673c`.

## `src/safety/chatInjectionGuard.ts`

Rust: native/src/safety.rs (Authorization, RateLimit, protected, region_protected, sensitive, redact); native/src/minecraft/game.rs (safe_break)

Public declarations: `SanitizedChat`, `sanitizeChatMessage`, `wrapUntrusted`, `SECRET_REFUSAL`, `safeChatReply`, `detectInjectedIntent`.

Methods/algorithms: (module functions listed above).

SHA-256: `746e6eb23183f7da1dbbfa5e69f2643c439fefb51df7004ef6b28d713b763d0b`.

## `src/safety/permissions.ts`

Rust: native/src/safety.rs (Authorization, RateLimit, protected, region_protected, sensitive, redact); native/src/minecraft/game.rs (safe_break)

Public declarations: `AuthorizationDecision`, `ChatPrincipal`, `AuthorizationService`.

Methods/algorithms: `isAuthorized`, `addAuthorized`, `authorize`, `consumeRateLimit`, `remainingQuota`, `reset`.

SHA-256: `82cde31b77e781c4168a88bc68e220074868b2beeccb732587e82e68b8e60e46`.

## `src/skills/basic/lookAt.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `DEFAULT_LOOK_MS`, `MAX_LOOK_MS`, `LookAtSkill`, `createLookAtSkill`.

Methods/algorithms: `execute`.

SHA-256: `c9c619cd615f26e6efe0b30f6cd6b47e176ed81f2fd0c1b47fe9338fff7a679b`.

## `src/skills/basic/stop.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `StopSkill`, `createStopSkill`.

Methods/algorithms: `execute`.

SHA-256: `8fa0d9ee6ba722cc7864f1541aee29958875b1c7d1414f3172dd71ce3c205216`.

## `src/skills/basic/wait.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `MAX_WAIT_MS`, `WaitSkill`, `createWaitSkill`.

Methods/algorithms: `execute`.

SHA-256: `0825ed1c70ad65db7e8ce39c62b84286e0d39849ebc9f46182301de8c8c143b3`.

## `src/skills/building/buildStructure.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `STRUCTURE_TYPES`, `StructureType`, `MAX_BUILD_BLOCKS`, `planStructure`, `BuildStructureParams`, `BuildStructureSkill`, `createBuildStructureSkill`.

Methods/algorithms: `execute`.

SHA-256: `bbc918b7750e639f16b06d3354bf3a701a91b01546b913330e612e78433055de`.

## `src/skills/building/placeBlock.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `PlaceBlockSkill`, `createPlaceBlockSkill`.

Methods/algorithms: `execute`.

SHA-256: `2e4e8f16040618597a246b9ba8c5078c294a037bc846b5b7229f89a0f4ee6543`.

## `src/skills/combat/attackHostile.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `ATTACK_DURATION_MS`, `AttackHostileSkill`, `createAttackHostileSkill`.

Methods/algorithms: `execute`.

SHA-256: `d2d92bb3f47e93123b1fe1f0d7edb44b001f1689706908c890063286914166e0`.

## `src/skills/index.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `createSkillRegistry`, `getSkill`, `conflictGroupsFor`.

Methods/algorithms: (module functions listed above).

SHA-256: `d79068dc241132700bc2a5b8b3dd424ad55365b5934e29fdbb2576ef82f795a2`.

## `src/skills/internal/helpers.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `ACTION_TIMEOUT_MS`, `PATHING_HAZARDS`, `OpOutcome`, `NavOutcome`, `describeError`, `isCancellation`, `clamp`, `posKey`, `floorPos`, `formatPos`, `normaliseBlockName`, `isDangerousBlock`, `reportResult`, `cancelledResult`, `failedResult`, `reportProgress`, `guardedOp`, `toNavOutcome`, `NavigateOptions`, `navigateToPosition`, `navigateToPlayer`, `neighbours`, `approachBlock`, `resolveEntityId`.

Methods/algorithms: (module functions listed above).

SHA-256: `16e8e3608c9e061f7bc29623dc466579f7189bb280a72f016b6eb78c047593d9`.

## `src/skills/inventory/chestManager.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `CHEST_SEARCH_DISTANCE`, `TransferResult`, `transferIntoChest`, `transferOutOfChest`, `DepositItemsSkill`, `WithdrawItemsSkill`, `createDepositItemsSkill`, `createWithdrawItemsSkill`.

Methods/algorithms: `execute`.

SHA-256: `bf54208103fb25788ec41d7b42a6bcb791d3e071ba648b445a80873dc8b9feb6`.

## `src/skills/inventory/dropItem.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `DropItemSkill`, `createDropItemSkill`.

Methods/algorithms: `execute`.

SHA-256: `8acde296f615badb6c7f68b4dff7cd2832b150f816ac502c9dedcb17502ec1ca`.

## `src/skills/inventory/equipItem.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `EquipItemSkill`, `createEquipItemSkill`.

Methods/algorithms: `execute`.

SHA-256: `9e0c8b7f592c12856d7be42f55ef73e7face2e64038a8673f35f160bf2344715`.

## `src/skills/inventory/pickupItems.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `PickupItemsParams`, `PickupItemsSkill`, `createPickupItemsSkill`.

Methods/algorithms: `execute`, `itemCount`.

SHA-256: `e60f0ce259d5d0596353b57b0b064d3dbed5b7307e20d1d04adec37d4c881af5`.

## `src/skills/mining/collectResource.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `CollectResourceSkill`, `createCollectResourceSkill`.

Methods/algorithms: `execute`.

SHA-256: `b2958039a5735a717af46f18ea02a7ef46074228dac6ae89741dd8e4941d9001`.

## `src/skills/mining/mineBlock.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `MineBlockSkill`, `createMineBlockSkill`.

Methods/algorithms: `execute`.

SHA-256: `010a72e973b9c2b6e39255701270336fffc70c796337c163b891644d491f1258`.

## `src/skills/mining/shared.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `MAX_BLOCKS_PER_TASK`, `SEARCH_DISTANCE`, `MAX_MINING_FAILURES`, `MineRunResult`, `MineRunOptions`, `runMining`, `resolveResourceNames`, `humaniseBlockName`.

Methods/algorithms: (module functions listed above).

SHA-256: `a4b01016042f6e027613045abf1505cccd1e2f5adfca11b1e11f3286c1960152`.

## `src/skills/movement/followPlayer.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `FollowPlayerParams`, `FollowPlayerSkill`, `createFollowPlayerSkill`.

Methods/algorithms: `execute`.

SHA-256: `255a0302c5b367fecc008f909b52e2483137683e85d4d6e8a2eb0a7807f7ea61`.

## `src/skills/movement/gotoPlayer.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `GotoPlayerSkill`, `createGotoPlayerSkill`.

Methods/algorithms: `execute`.

SHA-256: `8ff35255ccda6e0b17d6d6d1b2af6c32b89a2836c8b019318ad4b2ec66b6e07e`.

## `src/skills/movement/gotoPosition.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `GotoPositionSkill`, `createGotoPositionSkill`.

Methods/algorithms: `execute`.

SHA-256: `5f4626fc5b265ee30ee17378f849c782da9475ff3347b0335f12420d6d569975`.

## `src/skills/survival/autoEat.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `HUNGER_THRESHOLD`, `AutoEatSkill`, `createAutoEatSkill`.

Methods/algorithms: `execute`, `pickFood`.

SHA-256: `b72a32f921b95e00cc212732ebf2fc235615f3c47e7b98159ce1088bf86bbe88`.

## `src/skills/survival/defend.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `DefendSkill`, `createDefendSkill`.

Methods/algorithms: `execute`, `engage`, `useWeapon`.

SHA-256: `63dba49be7f1c167e89662d67b8816d81d202db18f7ee77b36bf93eedbee92f9`.

## `src/skills/survival/escapeDanger.ts`

Rust: native/src/skills.rs (Skills::execute); native/src/minecraft/game.rs (Game for NativeGame); native/src/mining.rs

Public declarations: `EscapeDangerParams`, `DangerReport`, `detectDanger`, `isHostile`, `EscapeDangerSkill`, `createEscapeDangerSkill`.

Methods/algorithms: `execute`.

SHA-256: `018c564411386da5e5dfe35dfda4e80ab5ba2bcf22037be2fa3b98565118183a`.

## `src/types/actions.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `ACTION_TYPES`, `ActionType`, `BaseAction`, `MoveToPlayerAction`, `MoveToPositionAction`, `FollowPlayerAction`, `StopAction`, `LookAtAction`, `WaitAction`, `MineBlockAction`, `CollectResourceAction`, `EquipItemAction`, `DropItemAction`, `DepositItemsAction`, `WithdrawItemsAction`, `PickupItemsAction`, `PlaceBlockAction`, `BuildStructureAction`, `EatAction`, `AttackHostileAction`, `DefendPlayerAction`, `BotAction`, `isActionType`.

Methods/algorithms: (module functions listed above).

SHA-256: `923f0f7827c9caa3041dda710910521fe5a562899c193c258cb42f650dcb0fa4`.

## `src/types/facade.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `Facing`, `BlockRef`, `InventoryEntry`, `ChestRef`, `DroppedItemRef`, `NavigationOptions`, `MoveResult`, `MinecraftFacade`, `BotRuntimeState`.

Methods/algorithms: `getHealth`, `getHunger`.

SHA-256: `142b198af4a6c24477e7066fa956d137d7cdabe13c9a69032bf2cbe1c0c97f57`.

## `src/types/index.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: (re-exports only).

Methods/algorithms: (module functions listed above).

SHA-256: `722820cc9c80e12add29312bbd96617dcdefaf2569b70e180937b13ab36b00fd`.

## `src/types/memory.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `NamedLocation`, `PlayerPreference`, `ShortTermMemory`, `PersistentMemory`, `MemorySnapshot`, `MemoryStore`, `MAX_RECENT_INSTRUCTIONS`, `MAX_RECENT_FAILURES`, `MAX_RECENT_LOCATIONS`.

Methods/algorithms: (module functions listed above).

SHA-256: `c91e3f302438ad1382f867dfcb5000b961512c1b9e35f8e51a08745d8f9f5ab1`.

## `src/types/provider.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `AiMessage`, `CompletionRequest`, `CompletionResult`, `ProviderError`, `ProviderErrorKind`, `AiProvider`, `ProviderTier`, `ProviderStats`.

Methods/algorithms: (module functions listed above).

SHA-256: `217f24baa3c820f69e355a9f656c21f55ea6b91a90164d0111cc77fe92ac413d`.

## `src/types/skill.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `SkillResult`, `SkillInput`, `Skill`, `SkillRegistry`, `GotoPlayerParams`, `GotoPositionParams`, `MineParams`, `CollectParams`, `PlaceParams`, `ItemParams`, `ChestParams`, `EatParams`, `AttackParams`, `DefendParams`, `LookParams`, `WaitParams`.

Methods/algorithms: (module functions listed above).

SHA-256: `10837fc66b71fde2b8a8077d32952bd8a7ed231df8721b68e949ab7c5c4780c3`.

## `src/types/task.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `TASK_STATUSES`, `TaskStatus`, `CONFLICT_GROUP`, `ConflictGroup`, `TaskConflictGroup`, `TaskProgress`, `TaskRecord`, `CreateTaskInput`, `ProgressReporter`, `ExecutionContext`, `isTerminalStatus`.

Methods/algorithms: (module functions listed above).

SHA-256: `7782c6c8332e2728b9912565bed6ff962f6a8ff166c0153bafd13a3683e7e6ae`.

## `src/types/world.ts`

Rust: native/src/actions.rs (Action, Position, Structure); native/src/world.rs (Game, GameError, Snapshot, Entity, Player, Item, Block); native/src/executor.rs (Job, State); native/src/ai.rs (Request, Message, AiError)

Public declarations: `Vec3Like`, `BlockPos`, `EntitySummary`, `PlayerSummary`, `ItemSummary`, `InventorySummary`, `TimeOfDay`, `WorldContext`, `distance3`, `roundPos`.

Methods/algorithms: (module functions listed above).

SHA-256: `27b27622b3af2af08f74286109ae148ed443a6588ee3fe7e8b6563203408a714`.

## `src/utils/logger.ts`

Rust: native/src/world.rs (delay); native/src/safety.rs (redact, chat_reply); native/src/minecraft/mod.rs (supervisor backoff, tracing filter)

Public declarations: `LogLevel`, `LogFields`, `Logger`, `LoggerOptions`, `createLogger`, `silentLogger`.

Methods/algorithms: (module functions listed above).

SHA-256: `dfdc3ae008e7a483842728a6eb52853565b9fdad46b52ce1fb6081c49d38191a`.

## `src/utils/redact.ts`

Rust: native/src/world.rs (delay); native/src/safety.rs (redact, chat_reply); native/src/minecraft/mod.rs (supervisor backoff, tracing filter)

Public declarations: `REDACTED`, `isSecretKey`, `redactValue`, `scrubText`, `scrubForChat`.

Methods/algorithms: (module functions listed above).

SHA-256: `16535ccfb97448363b968d2027ff8de8f32e1d79952902d17ef3b86fc91c0954`.

## `src/utils/retry.ts`

Rust: native/src/world.rs (delay); native/src/safety.rs (redact, chat_reply); native/src/minecraft/mod.rs (supervisor backoff, tracing filter)

Public declarations: `RetryOptions`, `retry`.

Methods/algorithms: (module functions listed above).

SHA-256: `ea315bee46e03e1aa03913280a57cfb2137c06271ba4cc6604d1a74fd5e57eaa`.

## `src/utils/sleep.ts`

Rust: native/src/world.rs (delay); native/src/safety.rs (redact, chat_reply); native/src/minecraft/mod.rs (supervisor backoff, tracing filter)

Public declarations: `AbortedError`, `sleep`, `Deferred`, `createDeferred`, `waitUntil`, `withTimeout`.

Methods/algorithms: (module functions listed above).

SHA-256: `7cb9e30eb90528b0889a72a6aba548066064b27d927826b93d08fe8f91c46361`.

## `src/world/worldState.ts`

Rust: native/src/world.rs (Snapshot, Point); native/src/minecraft/game.rs (NativeGame::snapshot, ScanCache)

Public declarations: `WorldStateOptions`, `DEFAULT_INTERESTING_BLOCKS`, `WorldState`.

Methods/algorithms: `invalidate`, `nearbyBlocks`, `nearbyChests`, `buildContext`, `timeOfDay`, `distanceToPlayer`.

SHA-256: `6d6dc65a252748977b4ebd85b174950e0aa2e0438fc23f50c4d668ae38077492`.

## `tests/ai/providerFallback.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- falls back A -> B -> C when A is rate limited and B times out
- stops at the deadline instead of hanging when every provider stalls
- skips providers whose circuit is open and probes once half-open
- does not fall back when the caller aborts (the !stop path)
- ranks the fastest healthy provider first for the fast tier
- prefers the planning-tier provider for the planning tier
- skips providers with no API key
- falls back past a provider with a rejected key, and opens its circuit
- reports AIUnavailableError with per-provider failure detail
- parses plain JSON
- parses JSON wrapped in a code fence
- parses JSON embedded in prose
- returns undefined for text with no JSON

SHA-256: `32dc7616566dafd82c5c2fade784cefc5df0fd1e37ea8107abbe8d6068f68a1c`.

## `tests/ai/structuredActions.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- accepts a well-formed allowlisted action
- drops an action whose type is not in ACTION_TYPES
- never emits a type outside the allowlist, whatever the model returns
- drops entries with missing or wrongly-typed required fields
- clamps absurd numbers instead of trusting them
- rejects a payload that is not an action list at all
- drops non-object entries without throwing
- caps the number of actions from one response
- parses plain JSON
- parses JSON wrapped in a markdown code fence
- parses JSON embedded in prose
- yields no actions for malformed JSON instead of throwing
- never throws on adversarial text
- still executes the legitimate part of a partially-injected plan
- treats an injected instruction as data inside a fenced block
- states the allowlist and the injection policy in the system prompt
- requests JSON mode and returns validated actions
- resolves with no actions (rather than throwing) on an unusable reply
- returns immediately without calling a provider when already aborted
- forwards the abort signal to the provider so the HTTP call is cancelled
- truncates entities, blocks, inventory and chat
- limits concurrency to maxConcurrentRequests and queues the rest
- cancelAll aborts in-flight planning
- exposes provider stats for status reporting
- rejects further planning after dispose
- builds adapters from config when none are supplied
- trims session lists to the shared constants
- round-trips persistent state through a file atomically
- starts fresh instead of crashing on a corrupt memory file
- is a no-op when no file is configured
- does not log the OpenAI key on a server error
- does not log the Gemini key even though it travels in the query string
- does not include the key in a thrown ProviderError message
- classifies HTTP statuses onto the shared error taxonomy
- distinguishes a timeout from a caller abort
- classifies a network failure
- sends the Gemini system prompt as systemInstruction, not a role
- sends a Bearer header and JSON mode to OpenAI-compatible endpoints

SHA-256: `cf8e251e5ff92ee3028f2b535085cfe580dcd3a98bbc2595d5d8b879b5c98c86`.

## `tests/commands/chatListener.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- routes !stop to stop
- honours !stop even when the line also looks like other work
- matches !stop case-insensitively and ignores extra words
- still honours !stop after the player has exhausted their rate limit
- routes !come to a deterministic action
- routes !goto to a deterministic action
- routes !mine to a deterministic action
- routes local commands to the local handler, not to the AI
- sends no deterministic command to the AI
- falls back to the AI when a deterministic command is malformed
- routes an unknown !command to the AI
- routes plain text to the AI for an authorized player
- matches authorized players case-insensitively
- ignores plain text from an unauthorized player
- ignores a deterministic command from an unauthorized player
- ignores !stop from an unauthorized player
- ignores a local command from an unauthorized player
- never routes an unauthorized player to the AI, whatever they say
- ignores the bot\
- ignores empty messages
- reports rate limiting distinctly from authorization
- gives each player their own rate-limit budget
- runs a deterministic action without touching the AI
- handles a local command through the local handler
- stops everything and confirms for !stop
- forwards sanitized natural language to the AI
- does nothing at all for an ignored message
- never calls the AI for an unauthorized player, even via handle
- never executes a deterministic command from an unauthorized player
- refuses an API key request with SECRET_REFUSAL and no AI call
- refuses environment-variable, token, shell and rcon requests
- refuses a secret request wrapped in a prompt-injection attempt
- does not leak the secret through the refusal text itself
- still answers a benign request
- does not throw when a deterministic action fails
- does not throw when the AI handler fails
- reports a routing failure instead of crashing the listener

SHA-256: `6e47c8464808f7aa88d22d1cd076a5fd68274e281cc4003212c08e4b478e27b2`.

## `tests/commands/commandParser.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- classifies a prefixed command
- lower-cases the command name and collapses whitespace
- classifies unprefixed text as plain chat
- trims surrounding whitespace on chat
- classifies empty and whitespace-only input as empty
- classifies a bare prefix with no command as empty
- treats a malformed prefix usage as chat, never as a command
- honours a custom prefix
- reports a no-argument command with an empty arg list
- accepts hyphens and digits in a command name
- builds move_to_player for !come (player filled in by the caller)
- ignores stray arguments to !come
- builds move_to_position for !goto
- accepts negative and zero coordinates
- builds follow_player, with an optional positive distance
- drops a non-positive follow distance rather than trusting it
- builds defend_player with the fixed default radius
- builds stop for !stop
- builds eat, with and without an item
- builds equip_item
- lower-cases item names
- builds drop_item with an optional count
- builds mine_block, defaulting the count to 16
- builds deposit_items, with and without an item
- builds withdraw_items with an item and count
- rejects malformed !goto coordinates
- rejects a missing or malformed player name
- rejects zero, negative and non-numeric counts
- caps a drop/withdraw count at a single stack
- requires an item where one is mandatory
- rejects an unknown command
- rejects item names with path traversal
- rejects item names carrying injection characters
- rejects coordinates that are NaN, Infinity or otherwise non-integer
- rejects absurdly long coordinates
- rejects a count that overflows the safe integer range
- parses plain and negative integers
- rejects anything that is not a plain integer literal
- rejects integers beyond 12 digits
- parses a coordinate triple
- returns null when any element is invalid or the list is empty
- accepts 1..16 alphanumerics and underscores
- rejects empty, overlong and special-character names
- accepts positive counts within the cap
- rejects zero, negatives and anything over the cap
- lower-cases a valid named location
- rejects traversal and overlong location names
- classifies every command the parser can convert as deterministic
- marks the chat-only commands as local, and local ones as deterministic
- does not treat an arbitrary word as deterministic

SHA-256: `fa37f2e23aa2218de798f3eea2e26eb993cca2f4c460f8386597e032b03b72dc`.

## `tests/config/config.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- accepts defaultTestEnv()
- fills defaults for optional values
- uses the documented default model for each provider
- reads optional fields when supplied
- reports every problem in one error instead of failing one at a time
- formats the ConfigError message with every issue listed
- fails when MC_HOST is missing
- treats an empty AUTHORIZED_PLAYERS value as missing
- fails when the only selected AI provider has no key
- fails when AI_PROVIDER_PRIORITY names no known provider
- drops providers without a key and keeps priority order
- normalises priority casing and whitespace
- ignores unknown names in AI_PROVIDER_PRIORITY
- honours a per-provider model override
- surfaces MC_AUTH=offline as an issue so it must be an explicit choice
- does not warn for the default microsoft auth
- rejects an unknown MC_AUTH value
- refuses a config where the bot authorizes itself
- allows a bot username that merely looks similar
- rejects a non-numeric MC_PORT
- rejects an out-of-range MC_PORT
- rejects a non-numeric safety limit
- rejects a safety limit below its minimum
- rejects an unparsable boolean and keeps the fallback
- rejects an unknown LOG_LEVEL / LOG_FORMAT
- accepts the documented boolean spellings
- falls back to defaults for values that are absent
- matches exactly
- is case-insensitive in both directions
- does not match on partial names
- rejects an empty username
- str trims and treats blank values as absent
- csv splits, trims and drops empty entries
- int falls back when absent, and records the issue when invalid
- bool falls back when absent, and records the issue when invalid

SHA-256: `a60a2ca0938dfe0803b717dc43e592b2486de0637372228513bf3afdab363d56`.

## `tests/executor/taskCancellation.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- aborts the signal the moment cancel() returns
- records the cancellation reason on the record
- aborts a task that is currently running its body
- aborts through the handle and through record.cancel()
- cancels a task that has not started running yet
- is idempotent and safe for an unknown id
- cancels a task by conflict group
- cancels every active task and reports the count
- does not count already-settled tasks
- returns 0 when there is nothing to cancel
- leaves the manager empty afterwards
- cancels the previous task when a group is re-claimed
- keeps exactly one active task per group
- lets different groups run concurrently
- does not arbitrate the 
- frees the group once the task settles
- runs every cleanup exactly once on cancel
- runs cleanups exactly once on completion
- does not let a throwing cleanup escape cancel()
- runs an immediately-registered cleanup for an unknown task
- runs a cleanup immediately when the task has already settled
- removes settled tasks and keeps active ones
- excludes settled tasks from list() by default
- includes settled tasks when asked
- reports no active task for a settled group
- returns the body result and marks the task completed
- marks the task failed and rethrows on a body error
- records a non-Error rejection as a string
- returns null without running the body when already cancelled
- returns null and cancels when aborted mid-flight
- runs cleanups registered inside the body when execute settles
- refuses to run a task that has already settled
- notifies the settle listener exactly once per task
- reports progress and messages through the execution context
- moves a running task through paused and back
- ignores pause/resume for a settled task
- cannot resume a task that was never paused
- starts a queued task with the supplied metadata
- gives every task a unique id
- supports the setPlanning transition

SHA-256: `fae8729c6f299a1cd7a5ffc50527689b57c8b6aca1438518244cb1f4588f6164`.

## `tests/safety/limitsAndGrief.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- allows actions up to the budget and then trips
- recovers once the window slides past a minute
- keeps denying inside the window
- treats 0 as 
- trips the mining counter at the ceiling and resets cleanly
- trips the building counter at the ceiling
- clamps requested counts into range
- reports a consistent snapshot
- rejects a non-positive or non-numeric mining count
- rejects a mining count above the per-task limit
- rejects an invalid or oversized drop count
- rejects a negative or non-numeric wait
- rejects a wait longer than the cap
- accepts a zero wait and a valid defend duration
- rejects a missing or malformed position
- rejects non-finite coordinates
- rejects positions outside the world border
- accepts an ordinary in-world position
- requires dimensions
- rejects a single oversized dimension
- rejects a non-positive or non-numeric dimension
- rejects a volume over the build limit even when each side fits
- accepts a structure within both the dimension and volume limits
- allows actions it has no specific rule for
- exposes the documented default ceilings
- refuses to break chests and other player structure blocks
- refuses a structure block even when explicitly requested
- refuses to break farmland and crops
- allows an explicitly requested protected block
- refuses a block the world tracker knows a player placed
- keys protected positions by floored coordinates
- allows natural stone, dirt and ores
- allows every ore
- allows logs and leaves
- allows an unknown block through (permissive default)
- allows placing into air and replaceable blocks
- rejects placing into an occupied position
- yields only when a human is right on top of the bot
- does not yield when no player distance is known
- recognises a player-owned chest but does not refuse it
- keeps the three categories disjoint where it matters
- classifies the blocks the tests rely on

SHA-256: `ccccc53517d38080a71085ce0d97f32c0696b2a774da06ae21e4a58bf2aacff9`.

## `tests/safety/promptInjection.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- flags classic prompt-injection phrases
- flags role-tag and delimiter injections
- does not flag ordinary chat
- still returns usable text for a flagged message
- replaces code fences and backticks so chat cannot break its data envelope
- strips attribute-less HTML-ish tags
- strips attribute-bearing tags too
- removes control characters used to hide instructions
- leaves plain text untouched
- truncates an overlong message and flags it
- respects a custom maxLength
- does not truncate a message inside the limit
- flags requests for credentials
- flags env-var-style credential names as sensitive
- flags requests for environment and files
- flags requests for shell and server control
- flags a bare shell name without needing the word 
- does not flag normal gameplay requests
- flags both suspicious and sensitive on a combined attack
- wraps chat in an explicit untrusted-data envelope
- closes the envelope even when the payload contains a fake terminator
- is a non-empty message that reveals nothing
- catches injection markers in model output
- catches protected-information attempts in model output
- passes clean model output
- redacts real-looking provider keys
- redacts KEY=value pairs
- leaves ordinary text alone
- recognises credential-shaped key names
- treats hyphenated credential names as secret
- does not flag ordinary key names
- never leaks the value of a secret-named key
- scrubs credential-looking strings under a safe key
- passes through ordinary values
- redacts filesystem paths
- redacts IP addresses and hosts
- redacts keys
- leaves a normal chat reply intact
- strips paths from a reply
- strips IP addresses from a reply
- strips a leaked key from a reply
- collapses whitespace and trims
- bounds the reply length
- honours a custom length bound
- returns an empty string for empty input

SHA-256: `8d8c16a3907520a480a491a9ab304b4c46a9543827dae3ac90bedfae4c43db8d`.

## `tests/skills/buildStructure.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- only supports the three whitelisted structures
- expands a wall into length x height blocks
- clamps absurd dimensions to the caps
- leaves a doorway in a simple house
- fails clearly when the bot lacks the material
- rejects a structure outside the whitelist
- builds a platform and reports progress
- stops building when aborted
- does not overwrite a block that is already in the way
- places one block where asked
- reports when the bot has none of that block
- refuses to overwrite an existing block
- equips an item in the inventory
- reports when the item is not carried

SHA-256: `a0318a1d70df3406fea475e17c50c1a59508175e18c78e912243bd119da6c011`.

## `tests/skills/chestManager.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- reports the correct number of items deposited
- deposits only the requested count
- fills an existing chest stack to 64 before opening a new one
- never claims more than a full chest can take
- reports gracefully when there is no chest nearby
- reports when the bot does not carry the item
- is cancellable mid-transfer
- takes the requested amount out of the chest
- stops when the inventory is full
- reports when the chest has nothing of that item
- falls back to the nearest chest when a named location is given
- drops the requested count on the floor
- clamps the request to what is carried
- routes to a chest when asked

SHA-256: `0002e676555b386a22746dc8f3de126f52b3dc47fdbfe39ff50e4884fe8a540c`.

## `tests/skills/fakes/fakeFacade.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

Retained test support fixture.

SHA-256: `ecf97925833a9ef0504b8cbae68d912bae6f02f860a442efd30606c390bda04b`.

## `tests/skills/followPlayer.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- stops promptly when the task is aborted mid-follow
- passes the abort signal into the facade navigation call
- returns immediately when the signal is already aborted
- stops without ever standing inside the player
- gives up when the player cannot be found

SHA-256: `0a179907dec335f9548a279cea6a425ba18aed4b98b0ad803fcd75941659b1e9`.

## `tests/skills/helpers/testContext.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

Retained test support fixture.

SHA-256: `c68da2665f9b2e745cc862c27e291e518a194ad9aa96179dc42f316c9bd2cb9d`.

## `tests/skills/mineBlock.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- mines exactly the requested count and stops there
- selects and equips the right tool before digging
- honours ctx.signal and stops mining mid-task
- returns immediately when already aborted
- clamps absurd requests to the safety maximum
- reports honestly when there is nothing to mine
- explains a missing tool rather than looping forever
- resolves a human phrase and mines it
- accepts several wood types for a generic 
- rejects an unknown resource without touching the world
- maps common phrases to block names

SHA-256: `362e8c187812848c53285ec235d0d9d35ca2ab8fcae31ab3e3d5d46c42caedb5`.

## `tests/skills/movement.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- walks to the player and stops short
- reports an unknown player without moving
- reports an unreachable player
- does nothing when already aborted
- walks to the requested coordinates
- rejects invalid coordinates
- stop halts movement
- wait honours an abort fired while sleeping
- wait clamps a silly duration
- look_at turns towards the position

SHA-256: `10b057bbc9a3cd5b1ef27d63dd87b78fa33add996b339a4d1fbdf04093181694`.

## `tests/skills/pickupItems.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- walks onto a dropped stack and reports the inventory delta
- only collects the filtered item
- stops as soon as the requested count is satisfied
- normalises a loosely spelled item name, e.g. 
- collects nothing when the item name does not match a dropped stack
- ignores stacks outside the search radius
- reports an unreachable stack instead of retrying it forever
- reports a shortfall when the ground holds less than requested
- does not pretend to collect when the inventory is full
- aborts promptly when !stop fires mid-walk

SHA-256: `38f4067767a13c33b17f531b87dc976cd67310a2230ebae0f41abff0d78226cd`.

## `tests/skills/registry.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- has a skill for every action type
- registers each skill under its own name
- declares conflict groups for every skill
- puts movement skills in the movement group
- puts mining and building in their own groups
- runs a skill straight from the registry

SHA-256: `afaf5a09494477e2437f36baa6930a7ad29d465b86495036ac8d1655929ba329`.

## `tests/skills/survival.test.ts`

Rust regression groups: `tests/native_core.rs`, `tests/native_skills.rs`; live protocol fixture: `tests/java_integration.rs` (opt-in, unrun). Original assertion-level coverage is not yet one-for-one.

- eats the best food carried when hungry
- does nothing when not hungry
- reports when hungry with no food
- detects nearby hazards
- moves away from lava
- does nothing when there is no danger
- stays near the player and stops on abort
- finishes cleanly when the duration elapses
- reports when there is nothing to fight
- swing at a hostile that is in range
- does not fight passive mobs

SHA-256: `79255c4d80d16557688a08526069b511fabf4752f8338de7bf1f9ed69acfb6f8`.

- `tsconfig.build.json` — SHA-256 `4f88a6b549f25ad52686e335ce937c5b06f940927e87d4e1016315cb7adfe5ee`; retained original configuration/dependency/test tooling.

- `tsconfig.json` — SHA-256 `9807302afca0c526f83b4b0e82f41cf7a190bf35074fa48c6a860c6d5c5fd875`; retained original configuration/dependency/test tooling.

- `vitest.config.ts` — SHA-256 `4a52dca9b34637968c0fe0741895a38707a32fcf787c478de74a4a3004e3cc18`; retained original configuration/dependency/test tooling.
