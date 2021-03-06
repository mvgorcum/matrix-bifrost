import { Logging } from "matrix-appservice-bridge";
import { IPurpleInstance } from "./purple/IPurpleInstance";
import { IAccountEvent, IChatJoinProperties } from "./purple/PurpleEvents";
import { Store } from "./Store";
import { MROOM_TYPE_GROUP, IRoomEntry } from "./StoreTypes";
import { Util } from "./Util";
import { Deduplicator } from "./Deduplicator";
import { ProtoHacks } from "./ProtoHacks";
import { GatewayHandler } from "./GatewayHandler";
const log = Logging.get("RoomSync");

interface IRoomMembership {
    room_name: string;
    params: IChatJoinProperties;
    membership: "join"|"leave";
}

const SYNC_RETRY_MS = 100;
const MAX_SYNCS = 8;
const JOINLEAVE_TIMEOUT = 60000;

export class RoomSync {
    private accountRoomMemberships: Map<string, IRoomMembership[]>;
    private ongoingSyncs = 0;
    constructor(
        private purple: IPurpleInstance,
        private store: Store,
        private deduplicator: Deduplicator,
        private gateway: GatewayHandler,
    ) {
        this.accountRoomMemberships = new Map();
        this.purple.on("account-signed-on", this.onAccountSignedin.bind(this));
    }

    public getMembershipForUser(user: string): IRoomMembership[]|undefined {
        return this.accountRoomMemberships.get(user);
    }

    public async sync(bot: any, intent: any) {
        log.info("Beginning sync");
        try {
            await this.syncAccountsToGroupRooms(bot, intent);
        } catch (err) {
            log.error("Caugh error while trying to sync group rooms", err);
            throw Error("Encountered error while syncing. Cannot continue");
        }
        log.info("Finished sync");
    }

    private async getJoinedMembers(bot: any, roomId: string): Promise<any> {
        let members;
        while (this.ongoingSyncs >= MAX_SYNCS) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        this.ongoingSyncs++;
        log.debug(`Syncing members for ${roomId} (${this.ongoingSyncs}/${MAX_SYNCS})`);
        while (members === undefined) {
            try {
                members = await bot.getJoinedMembers(roomId);
            } catch (ex) {
                if (ex.errcode === "M_FORBIDDEN") {
                    throw Error("Got M_FORBIDDEN while trying to sync members for room.");
                }
                log.warn(`Failed to get joined members for ${roomId}, retrying in ${SYNC_RETRY_MS}`, ex);
                await new Promise((resolve) => setTimeout(resolve, SYNC_RETRY_MS));
            }
        }
        this.ongoingSyncs--;
        return members;
    }

    /**
     * This function will collect all the members of the group rooms and decide
     * if the libpurple side needs to "reconnect" to the rooms.
     * @return [description]
     */
    private async syncAccountsToGroupRooms(bot: any, intent: any) {
        const rooms = await this.store.getRoomsOfType(MROOM_TYPE_GROUP);
        log.info(`Got ${rooms.length} group rooms`);
        await Promise.all(rooms.map(async (room: IRoomEntry) => {
            if (!room.matrix) {
                log.warn(`Not syncing entry because it has no matrix component`);
                return;
            }
            const roomId = room.matrix.getId();
            if (!room.remote) {
                log.warn(`Not syncing ${roomId} because it has no remote links`);
                return;
            }
            if (!this.purple.getProtocol(room.remote.get("protocol_id"))) {
                log.debug(`Not syncing ${roomId} because the purple backend doesn't support this protocol`);
                return;
            }
            const isGateway = room.remote.get("gateway");
            let members;
            try {
                 members = await this.getJoinedMembers(bot, roomId);
            } catch (ex) {
                log.warn(`Not syncing ${roomId} because we could not get room members: ${ex}`);
                return;
            }
            const userIds = Object.keys(members);
            for (const userId of userIds) {
                const isRemote = bot.isRemoteUser(userId);
                if (isRemote && isGateway) {
                    await this.gateway.rejoinRemoteUser(userId, roomId);
                    continue;
                } else if ((isRemote && !isGateway) || isGateway) {
                    // Don't handle remote non-gateway users, or matrix gateway users.
                    continue;
                }
                const remotes = (await this.store.getRemoteUsersFromMxId(userId)).filter(
                    (ruser) => ruser && ruser.isAccount &&
                        ruser.protocolId === room.remote.get("protocol_id"),
                );
                if (remotes.length === 0 && !isRemote) {
                    log.warn(`${userId} has no remote accounts matching the rooms protocol`);
                    continue;
                }
                const remoteUser = remotes[0];
                log.info(`${remoteUser.id} will join ${room.remote.get("room_name")} on connection`);
                const props = Util.desanitizeProperties(Object.assign({}, room.remote.get("properties")));
                await ProtoHacks.addJoinProps(room.remote.get("protocol_id"), props, userId, intent);
                const acctMemberList = this.accountRoomMemberships.get(remoteUser.id) || [];
                acctMemberList.push({
                    room_name: room.remote.get("room_name"),
                    params: props,
                    membership: "join",
                });
                this.accountRoomMemberships.set(remoteUser.id, acctMemberList);
            }
        }));
    }

    private async onAccountSignedin(ev: IAccountEvent) {
        log.debug(`${ev.account.username} signed in, checking if we need to reconnect them to some rooms`);
        const matrixUser = await this.store.getMatrixUserForAccount(ev.account);
        const acct = this.purple.getAccount(
            ev.account.username,
            ev.account.protocol_id,
            matrixUser ? matrixUser.getId() : undefined,
        );
        if (matrixUser === null) {
            log.warn(`${ev.account.username} isn't bound to a matrix account. Disabling`);
            if (acct !== null) {
                acct.setEnabled(false);
                return;
            }
            log.error(`Tried to get ${ev.account.username} but libpurple found nothing. This shouldn't happen!`);
            return;
        }
        const remoteId = Util.createRemoteId(ev.account.protocol_id, ev.account.username);
        const reconnectStack = this.accountRoomMemberships.get(remoteId) || [];
        log.debug(`Found ${reconnectStack.length} reconnections to be made for ${remoteId}`);
        let membership: IRoomMembership|undefined;
        membership = reconnectStack.pop();
        while (membership) {
            try {
                if (membership.membership === "join") {
                    log.info(`${remoteId} is joining ${membership.room_name}`);
                    log.debug("with", membership.params);
                    await acct!.joinChat(membership.params, this.purple, JOINLEAVE_TIMEOUT);
                    acct!.setJoinPropertiesForRoom(membership.room_name, membership.params);
                } else {
                    log.info(`${remoteId} is leaving ${membership.room_name}`);
                    await acct!.rejectChat(membership.params);
                    this.deduplicator.decrementRoomUsers(membership.room_name);
                }
            } catch (ex) {
                log.warn(`Failed to ${membership.membership} ${remoteId} to ${membership.room_name}:`, ex);
                // XXX: Retry behaviour?
            }

            membership = reconnectStack.pop();
        }
        this.accountRoomMemberships.delete(remoteId);
    }
}
