import { useAuth } from "./contexts/AuthContext";
import Landing from "./pages/Landing";
import DJEnvironment from "./pages/DJEnvironment";

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-[#07070f]">
      <span className="text-purple-400 text-lg animate-pulse tracking-widest">
        Beat<span className="text-white">Bot</span>
      </span>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingScreen />;
  if (!user) return <Landing />;
  return <DJEnvironment />;
}
