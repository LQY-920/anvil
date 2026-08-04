import { NavLink, Route, Routes } from "react-router-dom";
import BoardPage from "./pages/BoardPage.js";
import TaskDetailPage from "./pages/TaskDetailPage.js";
import AgentsPage from "./pages/AgentsPage.js";

export default function App() {
  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">⚒ Anvil</span>
        <NavLink to="/">看板</NavLink>
        <NavLink to="/agents">Agents</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<BoardPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
      </Routes>
    </div>
  );
}
