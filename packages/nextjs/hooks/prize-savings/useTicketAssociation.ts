import { useQuery } from "@tanstack/react-query";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { entityIdFromAddress } from "~~/utils/prize-savings/entities";
import { fetchAccount, isAssociated, needsAssociation, networkForChain } from "~~/utils/prize-savings/mirror";

/**
 * On Hedera an account must be associated with a token before it can hold it. Accounts with unlimited automatic
 * associations (the default for accounts created from an EVM address) need no action; everyone else calls
 * `associate()` on the ticket token once. `pollFast` re-checks every 2 s while an association is confirming, because
 * the mirror node lags consensus by a few seconds.
 */
export const useTicketAssociation = (address?: string, ticket?: string, { pollFast = false } = {}) => {
  const { targetNetwork } = useTargetNetwork();
  const network = networkForChain(targetNetwork.id);

  return useQuery({
    queryKey: ["ticket-association", network, address, ticket],
    enabled: Boolean(address && ticket && ticket !== "0x0000000000000000000000000000000000000000"),
    refetchInterval: pollFast ? 2_000 : 20_000,
    queryFn: async () => {
      const account = await fetchAccount(network, address!);
      if (!account) return { accountExists: false, needsAssociation: false };
      const associated = await isAssociated(network, account.account, entityIdFromAddress(ticket!));
      return { accountExists: true, needsAssociation: needsAssociation(account, associated) };
    },
  });
};
