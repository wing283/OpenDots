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

it(
  'rejects recovered final content already present as the latest assistant message',
  () => {
  expect(
    recoveredSupervisorMessage(
      {
        id: 'supervisor-recovery:sv-2:final',
        role: 'assistant',
        content: 'Same final answer.',
      },
      [
        { id: 'user-2', role: 'user', content: 'Question.' },
        {
          id: 'assistant-original',
          role: 'assistant',
          content: 'Same final answer.',
        },
      ],
    ),
    ).toBeNull();
  },
);

it(
  'does not suppress a repeated answer when the latest visible message is a user turn',
  () => {
  expect(
    recoveredSupervisorMessage(
      {
        id: 'supervisor-recovery:sv-3:final',
        role: 'assistant',
        content: 'Repeated answer.',
      },
      [
        {
          id: 'assistant-old',
          role: 'assistant',
          content: 'Repeated answer.',
        },
        { id: 'user-new', role: 'user', content: 'Ask again.' },
      ],
    ),
    ).toEqual({
      id: 'supervisor-recovery:sv-3:final',
      role: 'assistant',
      content: 'Repeated answer.',
    });
  },
);
