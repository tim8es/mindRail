import type { ActorRef } from '@mindrail/contracts';

import type {
  ApplicationCommand,
  ApplicationCommandName,
  ApplicationQuery,
  ApplicationQueryName,
  CommandResponse,
  QueryResponse,
} from './protocol.ts';

export interface AuthenticatedPrincipal {
  subject: string;
}

export interface PrincipalClaim {
  workspaceId: string;
  actor: ActorRef;
  sessionId?: string;
  operation:
    | { kind: 'command'; name: ApplicationCommandName }
    | { kind: 'query'; name: ApplicationQueryName };
}

export interface PrincipalAuthorizer {
  authorize(principal: AuthenticatedPrincipal, claim: PrincipalClaim): boolean | Promise<boolean>;
}

export interface ApplicationDispatcher {
  dispatchCommand(command: ApplicationCommand): CommandResponse | Promise<CommandResponse>;
  dispatchQuery(query: ApplicationQuery): QueryResponse | Promise<QueryResponse>;
}
