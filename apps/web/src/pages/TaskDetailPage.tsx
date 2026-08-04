import { useParams } from "react-router-dom";
import TaskPanel from "../components/TaskPanel.js";

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <TaskPanel taskId={id!} />;
}
