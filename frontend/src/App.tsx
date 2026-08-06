import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { WorkflowListPage } from '@/pages/WorkflowListPage'
import { WorkflowEditorPage } from '@/pages/WorkflowEditorPage'
import { ChatPage } from '@/pages/ChatPage'
import { OutboxPage } from '@/pages/OutboxPage'
import { NotFoundPage } from '@/pages/NotFoundPage'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<WorkflowListPage />} />
        <Route path="/workflows/:id/edit" element={<WorkflowEditorPage />} />
        <Route path="/workflows/:id/chat" element={<ChatPage />} />
        <Route path="/outbox" element={<OutboxPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  )
}
