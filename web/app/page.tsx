'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { Setup } from '@/components/Setup';

function Home() {
  const params = useSearchParams();
  const router = useRouter();
  const highlight = params.get('n');

  // Clicking an alert that has no link of its own opens /?n=<id>; show it in the alert history.
  useEffect(() => {
    if (highlight) router.replace(`/advanced?n=${encodeURIComponent(highlight)}`);
  }, [highlight, router]);

  return highlight ? null : <Setup />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Home />
    </Suspense>
  );
}
