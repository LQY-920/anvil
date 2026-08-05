import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Bot, Hammer, Kanban, Moon, Sun } from "lucide-react";
import BoardPage from "./pages/BoardPage.js";
import TaskDetailPage from "./pages/TaskDetailPage.js";
import AgentsPage from "./pages/AgentsPage.js";
import { useTheme } from "./hooks/useTheme.js";
import { cn } from "@/lib/utils";

function pageTitle(pathname: string): string {
  if (pathname === "/") return "看板";
  if (pathname.startsWith("/agents")) return "Agents";
  if (pathname.startsWith("/tasks/")) return "任务详情";
  return "";
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
    isActive && "bg-accent font-medium text-foreground",
  );

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/40">
        <div className="flex items-center gap-2 px-4 py-4">
          <Hammer className="size-4 text-primary" aria-hidden="true" />
          <span className="text-base font-semibold tracking-tight">Anvil</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          <NavLink to="/" end className={navLinkClass}>
            <Kanban className="size-4 shrink-0" aria-hidden="true" />
            <span>看板</span>
          </NavLink>
          <NavLink to="/agents" className={navLinkClass}>
            <Bot className="size-4 shrink-0" aria-hidden="true" />
            <span>Agents</span>
          </NavLink>
        </nav>
        <button
          type="button"
          onClick={toggleTheme}
          className="m-2 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {theme === "dark" ? <Sun className="size-4 shrink-0" /> : <Moon className="size-4 shrink-0" />}
          <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
        </button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-6 py-3">
          <h1 className="text-lg font-semibold tracking-tight">{pageTitle(location.pathname)}</h1>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Routes>
            <Route path="/" element={<BoardPage />} />
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/agents" element={<AgentsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
