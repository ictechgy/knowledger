import { startDevelopmentIssuer as startIssuer } from '../../packages/auth/development-issuer.ts';
import type { StartDevelopmentIssuerOptions } from '../../packages/auth/development-issuer.ts';
export type { DevelopmentIssuer } from '../../packages/auth/development-issuer.ts';

/** Password-free fictional accounts belong only to this opt-in example. */
export function startDevelopmentIssuer(options: Omit<StartDevelopmentIssuerOptions,'accounts'>) {
  return startIssuer({...options,accounts:[
    {subject:'dev-sales-owner',label:'영업 담당자'},
    {subject:'dev-fulfillment-owner',label:'이행 담당자'},
    {subject:'dev-settlement-owner',label:'정산 담당자'},
  ]});
}
