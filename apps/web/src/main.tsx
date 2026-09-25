import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './styles.css';
import { Layout } from './Layout';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { NewPurchaseRequestPage } from './pages/NewPurchaseRequest';
import { NewSampleRequestPage } from './pages/NewSampleRequest';
import { RequestDetailPage } from './pages/RequestDetail';
import { ApprovalsPage } from './pages/Approvals';
import { WorkspacePage } from './workspace/Workspace';
import { QcsDetailPage } from './workspace/QcsDetail';
import { PoDetailPage } from './workspace/PoDetail';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 2 && (e as { status?: number }).status !== 403 && (e as { status?: number }).status !== 404, refetchOnWindowFocus: true } }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="requests/new/purchase" element={<NewPurchaseRequestPage />} />
            <Route path="requests/new/sample" element={<NewSampleRequestPage />} />
            <Route path="requests/:id" element={<RequestDetailPage />} />
            <Route path="requests/:id/edit" element={<NewPurchaseRequestPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="workspace" element={<WorkspacePage />} />
            <Route path="workspace/:panel" element={<WorkspacePage />} />
            <Route path="qcs/:id" element={<QcsDetailPage />} />
            <Route path="pos/:id" element={<PoDetailPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
