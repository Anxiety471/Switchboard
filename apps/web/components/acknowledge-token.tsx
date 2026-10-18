'use client';

import { useEffect } from 'react';
import { acknowledgeToken } from '../app/token-action';

export function AcknowledgeToken() {
  useEffect(() => {
    void acknowledgeToken();
  }, []);
  return null;
}
