import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api } from '../lib/api';
import { Card, ErrorText, Loading } from '../lib/ui';
import type { RequestDetail } from '../lib/types';
import { NewPurchaseRequestPage } from './NewPurchaseRequest';
import { NewServiceRequestPage } from './NewServiceRequest';

// "Edit & resubmit" opens the form that matches the request.
export function EditRequestPage() {
  const { id } = useParams();
  const { data, error, isLoading } = useQuery({ queryKey: ['request', id], queryFn: () => api.get<RequestDetail>(`/api/requests/${id}`) });
  if (isLoading) return <Loading />;
  if (error || !data) return <Card><ErrorText error={error} /></Card>;
  if (data.kind === 'service') return <NewServiceRequestPage />;
  return <NewPurchaseRequestPage />;
}
