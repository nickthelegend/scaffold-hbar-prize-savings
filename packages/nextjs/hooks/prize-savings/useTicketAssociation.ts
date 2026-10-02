import { useQuery } from "@tanstack/react-query";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { entityIdFromAddress } from "~~/utils/prize-savings/entities";
import { fetchAccount, isAssociated, networkForChain } from "~~/utils/prize-savings/mirror";

/**
 * On Hedera an account must be associated with a token before it can hold it. Accounts created from an EVM address
 * (MetaMask, faucet) usually have unlimited automatic associations, so they need no action; accounts with zero
 * auto-association slots must call `associate()` on the ticket token first.
 */
export const useTicketAssociation = (address?: string, ticket?: string) => {
  const { targetNetwork } = useTargetNetwork();
  const network = networkForChain(targetNetwork.id);

  return useQuery({
    queryKey: ["ticket-association", network, address, ticket],
    enabled: Boolean(address && ticket && ticket !== "0x0000000000000000000000000000000000000000"),
    refetchInterval: 20_000,
    queryFn: async () => {
      const account = await fetchAccount(network, address!);
      if (!account) return { accountExists: false, needsAssociation: false };
      const associated = await isAssociated(network, account.account, entityIdFromAddress(ticket!));
      const autoAssociates = account.max_automatic_token_associations !== 0;
      return { accountExists: true, needsAssociation: !associated && !autoAssociates };
    },
  });
};
