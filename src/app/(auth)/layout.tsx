export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900">mhud</h1>
          <p className="text-slate-500 mt-1 text-sm">Live meeting copilot on an agent-native kanban board</p>
        </div>
        {children}
      </div>
    </div>
  )
}
