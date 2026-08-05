import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import BoardPage from "./pages/BoardPage.js";
import TaskDetailPage from "./pages/TaskDetailPage.js";
import AgentsPage from "./pages/AgentsPage.js";
import { useTheme } from "./hooks/useTheme.js";

function pageTitle(pathname: string): string {
  if (pathname === "/") return "看板";
  if (pathname.startsWith("/agents")) return "Agents";
  if (pathname.startsWith("/tasks/")) return "任务详情";
  return "";
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function BoardIcon() {
  return (
    <svg {...iconProps}>
      <rect x="1.5" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="6.25" y="2.5" width="3.5" height="7" rx="1" />
      <rect x="11" y="2.5" width="3.5" height="4" rx="1" />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 5V2.5" />
      <circle cx="8" cy="2" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="6.25" cy="9" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="9.75" cy="9" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...iconProps}>
      <path d="M13.5 9.3A5.5 5.5 0 1 1 6.7 2.5a4.4 4.4 0 0 0 6.8 6.8Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </svg>
  );
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  return (
    <div className="app-shell">
      <aside className="sidenav">
        <div className="sidenav-brand">
          <span className="sidenav-brand-mark" aria-hidden="true">
            ⚒
          </span>
          <span className="sidenav-brand-name">Anvil</span>
        </div>
        <nav className="sidenav-nav">
          <NavLink to="/" end className="sidenav-link">
            <BoardIcon />
            <span className="sidenav-link-label">看板</span>
          </NavLink>
          <NavLink to="/agents" className="sidenav-link">
            <AgentsIcon />
            <span className="sidenav-link-label">Agents</span>
          </NavLink>
        </nav>
        <button type="button" className="theme-toggle" onClick={toggleTheme}>
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          <span className="sidenav-link-label">
            {theme === "dark" ? "浅色模式" : "深色模式"}
          </span>
        </button>
      </aside>
      <div className="content">
        <header className="page-header">
          <h1 className="page-title">{pageTitle(location.pathname)}</h1>
          <div className="page-actions">{/* 页面级操作位 */}</div>
        </header>
        <main className="page-main">
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
