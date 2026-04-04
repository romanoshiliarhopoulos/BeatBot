import { QRCodeSVG } from 'qrcode.react'

interface Props {
  sessionId: string
  onClose: () => void
}

export default function QRCodeModal({ sessionId, onClose }: Props) {
  const baseUrl = import.meta.env.VITE_APP_URL ?? window.location.origin
  const sessionUrl = `${baseUrl}/live/${sessionId}`

  const handleCopy = () => {
    navigator.clipboard.writeText(sessionUrl).catch(() => {})
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#0f0f1a] border border-white/10 rounded-2xl p-8 max-w-sm w-full mx-4 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-white text-lg font-bold mb-1">Live Session</h2>
        <p className="text-gray-500 text-xs mb-6">
          Scan to join or share the link
        </p>

        <div className="bg-white rounded-xl p-4 inline-block mb-6">
          <QRCodeSVG
            value={sessionUrl}
            size={220}
            level="M"
            bgColor="#ffffff"
            fgColor="#07070f"
          />
        </div>

        <div className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2 mb-4">
          <span className="text-gray-400 text-xs truncate flex-1 text-left font-mono">
            {sessionUrl}
          </span>
          <button
            onClick={handleCopy}
            className="shrink-0 px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors"
          >
            Copy
          </button>
        </div>

        <p className="text-gray-600 text-[10px] mb-4">
          Session ID: <span className="font-mono text-gray-400">{sessionId}</span>
        </p>

        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}
