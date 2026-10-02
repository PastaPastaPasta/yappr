import { engineStorage, engineSupervisor, setHydrationGate } from './index';

afterEach(() => {
  engineSupervisor.stop();
  setHydrationGate(() => Promise.resolve());
});

it('reads no storage or secrets until the hydration gate opens (SR-39, ENGINE.md §9.2)', async () => {
  let open: () => void = () => undefined;
  setHydrationGate(() => new Promise<void>((resolve) => (open = resolve)));
  const opened = jest.spyOn(engineStorage, 'open').mockRejectedValue(new Error('stop here'));
  const snapshot = jest.spyOn(engineStorage, 'snapshot');

  engineSupervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(engineSupervisor.getStatus().state).toBe('starting');
  expect(opened).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();

  open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toHaveBeenCalledTimes(1);
});
