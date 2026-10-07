import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ActivityStore, type ActivityCallView, type ActivityView } from "./activity-model";
import { activityQueryKeys, openActivityStream } from "./api";

export type ActivityConnection = "connecting" | "live" | "reconnecting";

type ActivityContextValue = {
  store: ActivityStore;
  connection: ActivityConnection;
};

const ActivityContext = createContext<ActivityContextValue | null>(null);

export function ActivityProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new ActivityStore(), []);
  const [connection, setConnection] = useState<ActivityConnection>("connecting");
  const queryClient = useQueryClient();

  useEffect(() => {
    const closeStream = openActivityStream({
      onOpen: () => setConnection("live"),
      onError: () => setConnection("reconnecting"),
      onSnapshot: (snapshot) => store.replaceSnapshot(snapshot),
      onCall: (event) => {
        store.applyCall(event);
        const call = event.call;
        if (call.status === "running") return;

        if (call.shell_id != null) {
          void queryClient.invalidateQueries({
            queryKey: activityQueryKeys.shellCalls(call.shell_id),
          });
        }
        if (call.cwd) {
          void queryClient.invalidateQueries({
            queryKey: activityQueryKeys.workspaceShells(call.cwd),
          });
        }
      },
    });

    const timer = window.setInterval(() => store.tick(), 15_000);
    return () => {
      window.clearInterval(timer);
      closeStream();
    };
  }, [queryClient, store]);

  return (
    <ActivityContext.Provider value={{ store, connection }}>
      {children}
    </ActivityContext.Provider>
  );
}

export function useActivityView(): ActivityView {
  const { store } = useActivityContext();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useActivityConnection(): ActivityConnection {
  return useActivityContext().connection;
}

export function useShellActivityCalls(shellId: number): ActivityCallView[] {
  const { store } = useActivityContext();
  const getSnapshot = useCallback(() => store.getShellCalls(shellId), [shellId, store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

function useActivityContext(): ActivityContextValue {
  const value = useContext(ActivityContext);
  if (!value) throw new Error("ActivityProvider is missing");
  return value;
}
