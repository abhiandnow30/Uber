import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { RealtimeProvider } from './lib/realtime';
import { UnsavedChangesProvider } from './lib/unsaved';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

// A data router (rather than <BrowserRouter>) so pages can stop navigation away from unsaved changes.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <ToastProvider>
        <AuthProvider>
          <RealtimeProvider>
            <UnsavedChangesProvider>
              <App />
            </UnsavedChangesProvider>
          </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    ),
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
