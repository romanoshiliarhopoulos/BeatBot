import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import Landing from './pages/Landing'
import DJEnvironment from './pages/DJEnvironment'
import AudienceView from './pages/AudienceView'

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-[#07070f]">
      <span className="text-purple-400 text-lg animate-pulse tracking-widest">
        Beat<span className="text-white">Bot</span>
      </span>
    </div>
  )
}

function DJApp() {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Landing />
  return <DJEnvironment />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Audience view — no auth required */}
        <Route path="/live/:sessionId" element={<AudienceView />} />
        {/* Everything else — DJ app */}
        <Route path="*" element={<DJApp />} />
      </Routes>
    </BrowserRouter>
  )
}
