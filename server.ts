// bb-plugin-pane-workspaces — keyed split layouts: one per project, plus any number
// anchored to threads.
//
// The layouts themselves are client-side: they are bb's own `bb.splitLayout`
// localStorage value, saved and restored per workspace key by the frontend.
// The backend only serves a small index of projects and threads so the
// switcher can list projects, build a sensible first layout, drop panes whose
// thread has since been archived, and refresh thread-workspace metadata; plus
// one confirmation call (`threadsGone`) so a thread workspace is never dropped
// on a transient index miss.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const THREAD_LIMIT = 400;
const GONE_CHECK_LIMIT = 100;

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["personal", "standard"]),
});
const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentThreadId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  pinned: z.boolean(),
  updatedAt: z.number(),
  createdAt: z.number(),
  latestAttentionAt: z.number(),
});
export type IndexProject = z.infer<typeof projectSchema>;
export type IndexThread = z.infer<typeof threadSchema>;

export const rpcContract = defineRpcContract({
  index: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema), threads: z.array(threadSchema) }),
  },
  /** Toggle member-click switching from the Workspaces page. */
  setMemberClickSwitches: {
    input: z.object({ enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean() }),
  },
  /** Confirm which threads no longer exist (deleted or archived). Unknown
   * means the server could not tell; the caller keeps those records. */
  threadsGone: {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(GONE_CHECK_LIMIT) }),
    output: z.object({ gone: z.array(z.string()), unknown: z.array(z.string()) }),
  },
});

function looksLikeNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: unknown; code?: unknown; message?: unknown; name?: unknown };
  if (e.status === 404) return true;
  const text = [e.code, e.name, e.message].filter((v): v is string => typeof v === "string").join(" ");
  return /not[ _-]?found|no such thread|does not exist/i.test(text);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    memberClickSwitches: {
      type: "boolean",
      label: "Clicking a thread in a workspace switches to it",
      description: "A plain click on a thread that belongs to a thread workspace (the anchor or any nested thread) switches to that workspace and opens the thread there. Off restores plain navigation.",
      default: true,
    },
  });
  bb.rpc.register(rpcContract, {
    async setMemberClickSwitches({ enabled }) {
      await settings.experimental_set({ memberClickSwitches: enabled });
      return { enabled: (await settings.get()).memberClickSwitches };
    },
    async index() {
      const [projects, threads] = await Promise.all([
        bb.sdk.projects.list({ includePersonal: true }),
        bb.sdk.threads.list({ archived: false, limit: THREAD_LIMIT }),
      ]);
      return {
        projects: projects.map((p) => ({
          id: p.id,
          // 0.3.4: bb's sidebar calls the personal project "Threads"; say so, and that it has no project.
          name: p.kind === "personal" ? "Threads (no project)" : p.name,
          kind: p.kind,
        })),
        threads: threads.map((t) => ({
          id: t.id,
          projectId: t.projectId,
          parentThreadId: t.parentThreadId ?? null,
          title: t.title ?? t.titleFallback ?? "Untitled",
          status: t.status,
          pinned: t.pinnedAt !== null,
          updatedAt: t.updatedAt,
          createdAt: t.createdAt,
          latestAttentionAt: t.latestAttentionAt,
        })),
      };
    },
    async threadsGone({ threadIds }) {
      const gone: string[] = [];
      const unknown: string[] = [];
      await Promise.all([...new Set(threadIds)].map(async (threadId) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          if (thread.archivedAt !== null) gone.push(threadId);
        } catch (error) {
          if (looksLikeNotFound(error)) gone.push(threadId);
          else {
            bb.log.warn(`threadsGone: could not check ${threadId}; keeping its workspace: ${String(error)}`);
            unknown.push(threadId);
          }
        }
      }));
      return { gone: gone.sort(), unknown: unknown.sort() };
    },
  });

  // Coalesced "index moved" signal; the frontend refetches.
  bb.background.service("index-watch", {
    async start(signal) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const publish = () => {
        if (timer) return;
        bb.realtime.publish("index", { at: Date.now() });
        timer = setTimeout(() => {
          timer = null;
        }, 1000);
      };
      const unsubs = [
        bb.sdk.subscribe({ event: "thread:changed", callback: publish }),
        bb.sdk.subscribe({ event: "project:changed", callback: publish }),
      ];
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            if (timer) clearTimeout(timer);
            for (const u of unsubs) u();
            resolve();
          },
          { once: true },
        );
      });
    },
  });

  bb.log.info("workspaces loaded");
}
