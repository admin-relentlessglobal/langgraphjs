import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointTuple,
} from "./base.js";
import { SerializerProtocol } from "./serde/base.js";
import {
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
} from "./types.js";

function _generateKey(
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string
) {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

export class MemorySaver extends BaseCheckpointSaver {
  // thread ID ->  checkpoint namespace -> checkpoint ID -> checkpoint mapping
  storage: Record<
    string,
    Record<string, Record<string, [Uint8Array, Uint8Array, string | undefined]>>
  > = {};

  writes: Record<string, CheckpointPendingWrite[]> = {};

  constructor(serde?: SerializerProtocol) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    let checkpoint_id = config.configurable?.checkpoint_id;

    if (checkpoint_id) {
      const saved = this.storage[thread_id]?.[checkpoint_ns]?.[checkpoint_id];
      if (saved !== undefined) {
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const writes =
          this.writes[_generateKey(thread_id, checkpoint_ns, checkpoint_id)] ??
          [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          writes.map(async ([taskId, channel, value]) => {
            return [
              taskId,
              channel,
              await this.serde.loadsTyped("json", value as string),
            ];
          })
        );
        const checkpointTuple: CheckpointTuple = {
          config,
          checkpoint: (await this.serde.loadsTyped(
            "json",
            checkpoint
          )) as Checkpoint,
          metadata: (await this.serde.loadsTyped(
            "json",
            metadata
          )) as CheckpointMetadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id,
            },
          };
        }
        return checkpointTuple;
      }
    } else {
      const checkpoints = this.storage[thread_id]?.[checkpoint_ns];
      if (checkpoints !== undefined) {
        // eslint-disable-next-line prefer-destructuring
        checkpoint_id = Object.keys(checkpoints).sort((a, b) =>
          b.localeCompare(a)
        )[0];
        const saved = checkpoints[checkpoint_id];
        const [checkpoint, metadata, parentCheckpointId] = saved;
        const writes =
          this.writes[_generateKey(thread_id, checkpoint_ns, checkpoint_id)] ??
          [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          writes.map(async ([taskId, channel, value]) => {
            return [
              taskId,
              channel,
              await this.serde.loadsTyped("json", value as string),
            ];
          })
        );
        const checkpointTuple: CheckpointTuple = {
          config: {
            configurable: {
              thread_id,
              checkpoint_id,
              checkpoint_ns,
            },
          },
          checkpoint: (await this.serde.loadsTyped(
            "json",
            checkpoint
          )) as Checkpoint,
          metadata: (await this.serde.loadsTyped(
            "json",
            metadata
          )) as CheckpointMetadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: parentCheckpointId,
            },
          };
        }
        return checkpointTuple;
      }
    }

    return undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    // eslint-disable-next-line prefer-const
    let { before, limit } = options ?? {};
    const threadIds = config.configurable?.thread_id
      ? [config.configurable?.thread_id]
      : Object.keys(this.storage);
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? "";

    for (const threadId of threadIds) {
      const checkpoints = this.storage[threadId]?.[checkpointNamespace] ?? {};
      const sortedCheckpoints = Object.entries(checkpoints).sort((a, b) =>
        b[0].localeCompare(a[0])
      );

      for (const [
        checkpointId,
        [checkpoint, metadataStr, parentCheckpointId],
      ] of sortedCheckpoints) {
        // Filter by checkpoint ID
        if (
          before &&
          before.configurable?.checkpoint_id &&
          checkpointId >= before.configurable.checkpoint_id
        ) {
          continue;
        }

        // Parse metadata
        const metadata = (await this.serde.loadsTyped(
          "json",
          metadataStr
        )) as CheckpointMetadata;

        // Limit search results
        if (limit !== undefined) {
          if (limit <= 0) break;
          // eslint-disable-next-line no-param-reassign
          limit -= 1;
        }

        const writes =
          this.writes[
            _generateKey(threadId, checkpointNamespace, checkpointId)
          ] ?? [];
        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
          writes.map(async ([taskId, channel, value]) => {
            return [
              taskId,
              channel,
              await this.serde.loadsTyped("json", value as string),
            ];
          })
        );

        const checkpointTuple: CheckpointTuple = {
          config: {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: checkpointNamespace,
              checkpoint_id: checkpointId,
            },
          },
          checkpoint: (await this.serde.loadsTyped(
            "json",
            checkpoint
          )) as Checkpoint,
          metadata,
          pendingWrites,
        };
        if (parentCheckpointId !== undefined) {
          checkpointTuple.parentConfig = {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: checkpointNamespace,
              checkpoint_id: parentCheckpointId,
            },
          };
        }
        yield checkpointTuple;
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    if (threadId === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property.`
      );
    }
    if (checkpointNamespace === undefined) {
      throw new Error(
        `Failed to put checkpoint. The passed RunnableConfig is missing a required "checkpoint_ns" field in its "configurable" property.`
      );
    }

    if (!this.storage[threadId]) {
      this.storage[threadId] = {};
    }
    if (!this.storage[threadId][checkpointNamespace]) {
      this.storage[threadId][checkpointNamespace] = {};
    }

    const [, serializedCheckpoint] = this.serde.dumpsTyped(checkpoint);
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata);
    this.storage[threadId][checkpointNamespace][checkpoint.id] = [
      serializedCheckpoint,
      serializedMetadata,
      config.configurable?.checkpoint_id, // parent
    ];

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
    if (threadId === undefined) {
      throw new Error(
        `Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property`
      );
    }
    if (checkpointId === undefined) {
      throw new Error(
        `Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.`
      );
    }
    const key = _generateKey(threadId, checkpointNamespace, checkpointId);
    if (this.writes[key] === undefined) {
      this.writes[key] = [];
    }
    const pendingWrites: CheckpointPendingWrite[] = writes.map(
      ([channel, value]) => {
        const [, serializedValue] = this.serde.dumpsTyped(value);
        return [taskId, channel, serializedValue];
      }
    );
    this.writes[key].push(...pendingWrites);
  }
}