import { createFileRoute, redirect } from '@tanstack/react-router';
import { SelfServiceEnrollmentPage } from '../pages/SelfServiceEnrollmentPage/SelfServiceEnrollmentPage';
import { getSessionInfoQueryOptions } from '../shared/query';

// Route at /self-service-enrollment — accessible to any authenticated user.
// Non-authenticated users are redirected to the login page.
export const Route = createFileRoute('/self-service-enrollment')({
  beforeLoad: async ({ context }) => {
    const sessionInfo = (await context.queryClient.fetchQuery(getSessionInfoQueryOptions))
      .data;
    if (!sessionInfo.authorized) {
      throw redirect({ to: '/auth/login', replace: true });
    }
  },
  component: SelfServiceEnrollmentPage,
});
