import { PersistenceError, type WorkspaceMutationCoordinator } from '../ports.ts';

/**
 * Reference coordination primitive for the Workspace Durable Object boundary.
 *
 * A Cloudflare deployment should bind one instance to one Workspace Durable Object id. The optional
 * constructor binding models that deployment rule without importing Workers runtime types. Tests may
 * leave it unbound to simulate a Durable Object namespace in one process.
 */
export class WorkspaceDurableObjectCoordinator implements WorkspaceMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly boundWorkspaceId?: string) {}

  runSerialized<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.boundWorkspaceId !== undefined && workspaceId !== this.boundWorkspaceId) {
      return Promise.reject(
        new PersistenceError(
          'CONFLICT',
          `Workspace Durable Object ${this.boundWorkspaceId} cannot coordinate ${workspaceId}.`,
        ),
      );
    }

    const previous = this.tails.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(workspaceId, tail);

    return result.finally(() => {
      if (this.tails.get(workspaceId) === tail) {
        this.tails.delete(workspaceId);
      }
    });
  }
}
