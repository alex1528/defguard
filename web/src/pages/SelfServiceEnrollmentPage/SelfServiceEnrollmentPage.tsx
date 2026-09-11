import './style.scss';

import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/defguard-ui/components/Button/Button';
import { client } from '../../shared/api/api-client';

interface SelfServiceEnrollmentResponse {
  token: string;
  enrollment_url: string;
  deep_link: string;
}

/**
 * Self-service enrollment page.
 *
 * Accessible to any authenticated user at `/self-service-enrollment`.
 *
 * Flow:
 * 1. User lands here (typically after OIDC login via the desktop client)
 * 2. Page auto-calls POST /api/v1/enrollment/self-service
 * 3. Server returns { token, enrollment_url, deep_link }
 * 4. Page redirects to deep_link → desktop client catches it → auto-enrollment
 * 5. Fallback: manual "Open in Defguard Client" button
 */
export const SelfServiceEnrollmentPage = () => {
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [redirected, setRedirected] = useState(false);

  const { mutate: requestEnrollment, isPending, error } = useMutation({
    mutationFn: async () => {
      const response = await client.post<SelfServiceEnrollmentResponse>(
        '/enrollment/self-service',
      );
      return response.data;
    },
    onSuccess: (data) => {
      setDeepLink(data.deep_link);
    },
  });

  // Auto-request enrollment on mount
  useEffect(() => {
    requestEnrollment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-redirect to deep-link once available
  useEffect(() => {
    if (deepLink && !redirected) {
      setRedirected(true);
      const timer = setTimeout(() => {
        window.location.href = deepLink;
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [deepLink, redirected]);

  const handleManualOpen = useCallback(() => {
    if (deepLink) {
      window.location.href = deepLink;
    }
  }, [deepLink]);

  const handleRetry = useCallback(() => {
    setDeepLink(null);
    setRedirected(false);
    requestEnrollment();
  }, [requestEnrollment]);

  return (
    <div id="self-service-enrollment-page">
      <div className="card">
        <p className="title">Setting up your VPN client</p>

        {isPending && (
          <p className="description">
            Generating your enrollment configuration…
          </p>
        )}

        {error && (
          <>
            <p className="status error">
              Failed to generate enrollment token. Please try again or contact
              your administrator.
            </p>
            <div className="actions">
              <Button
                text="Try again"
                size="big"
                variant="primary"
                onClick={handleRetry}
              />
            </div>
          </>
        )}

        {deepLink && (
          <>
            <p className="description">
              Your VPN configuration is ready. The Defguard desktop client
              should open automatically.
            </p>
            <p className="status success">
              {redirected
                ? 'Redirecting to desktop client…'
                : 'Preparing redirect…'}
            </p>
            <div className="actions">
              <Button
                text="Open in Defguard Client"
                size="big"
                variant="primary"
                onClick={handleManualOpen}
              />
            </div>
            <p className="deep-link-fallback">
              If the client doesn't open,{' '}
              <a href={deepLink}>click here</a> or copy the link manually.
            </p>
          </>
        )}
      </div>
    </div>
  );
};
