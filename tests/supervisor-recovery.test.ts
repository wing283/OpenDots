import { expect, it } from 'vitest';
import { recoveredSupervisorMessage } from '../src/client/supervisor-recovery';

it('accepts a valid recovered Supervisor assistant message once', () => {
  expect(
    recoveredSupervisorMessage(
      {
        id: 'supervisor-recovery:sv-1:final',
        role: 'assistant',
        content: 'Recovered answer.',
      },
      [],
    ),
  ).toEqual({
    id: 'supervisor-recovery:sv-1:final',
    role: 'assistant',
    content: 'Recovered answer.',
  });
});

it('rejects duplicate recovered Supervisor messages by stable id', () => {
  expect(
    recoveredSupervisorMessage(
      {
        id: 'supervisor-recovery:sv-1:final',
        role: 'assistant',
        content: 'Recovered answer.',
      },
      ['supervisor-recovery:sv-1:final'],
    ),
  ).toBeNull();
});

it('rejects unsafe or incomplete recovered messages', () => {
  expect(
    recoveredSupervisorMessage(
      { id: 'x', role: 'user', content: 'not assistant' },
      [],
    ),
  ).toBeNull();
  expect(
    recoveredSupervisorMessage(
      { id: '', role: 'assistant', content: 'missing id' },
      [],
    ),
  ).toBeNull();
  expect(
    recoveredSupervisorMessage(
      { id: 'x', role: 'assistant', content: '   ' },
      [],
    ),
  ).toBeNull();
});
