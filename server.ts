// bb-plugin-workspaces — one split layout per project.
//
// The layouts themselves are client-side: they are bb's own `bb.splitLayout`
// localStorage value, saved and restored per project by the frontend. The
// backend only serves a small index of projects and threads so the switcher
// can list projects, build a sensible first layout, and drop panes whose
// thread has since been archived.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const THREAD_LIMIT = 400;

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["personal", "standard"]),
});
const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  pinned: z.boolean(),
  updatedAt: z.number(),
});
export type IndexProject = z.infer<typeof projectSchema>;
export type IndexThread = z.infer<typeof threadSchema>;

export const rpcContract = defineRpcContract({
  index: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema), threads: z.array(threadSchema) }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async index() {
      const [projects, threads] = await Promise.all([
        bb.sdk.projects.list({ includePersonal: true }),
        bb.sdk.threads.list({ archived: false, limit: THREAD_LIMIT }),
      ]);
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.kind === "personal" ? "Personal" : p.name,
          kind: p.kind,
        })),
        threads: threads.map((t) => ({
          id: t.id,
          projectId: t.projectId,
          title: t.title ?? t.titleFallback ?? "Untitled",
          status: t.status,
          pinned: t.pinnedAt !== null,
          updatedAt: t.updatedAt,
        })),
      };
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
