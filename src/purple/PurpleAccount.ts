/**
 * An interface for storing account data inside the userstore.
 */

// @ts-ignore - These are optional.
import { helper, plugins, buddy, accounts, messaging, Buddy, Account, Conversation, notify } from "node-purple";
import * as _fs from "fs";
import { Logging } from "matrix-appservice-bridge";
import { PurpleProtocol } from "./PurpleProtocol";
import { IChatJoinProperties, IUserInfo, IConversationEvent, IChatJoined } from "./PurpleEvents";
import { IBasicProtocolMessage } from "../MessageFormatter";
import { Util } from "../Util";
import { IPurpleInstance } from "./IPurpleInstance";
import { IPurpleAccount } from "./IPurpleAccount";
const fs = _fs.promises;

const log = Logging.get("PurpleAccount");

if (fs === undefined) {
    log.error(
`Warning: Your version of node doesn't support fs.promises.
(See: https://nodejs.org/api/fs.html#fs_fs_promises_api)

We don't yet support non-fs-promise versions of node.`,
);
    process.exit(1);
}

export interface IChatJoinOptions {
    identifier: string;
    label: string;
    required: boolean;
}

export class PurpleAccount implements IPurpleAccount {
    private acctData: Account | undefined;
    private enabled: boolean;
    private waitingJoinRoomProperties: IChatJoinProperties | undefined;
    private joinPropertiesForRooms: Map<string, IChatJoinProperties>;
    private userAccountInfoPromises: Map<string, () => any>;
    constructor(private username: string, public readonly protocol: PurpleProtocol) {
        this.enabled = false;
        this.userAccountInfoPromises = new Map();
        this.joinPropertiesForRooms = new Map();
    }

    get _waitingJoinRoomProps(): IChatJoinProperties|undefined { return this.waitingJoinRoomProperties; }

    get remoteId(): string { return Util.createRemoteId(this.protocol.id, this.username); }

    get name(): string { return this.acctData!.username; }

    get handle(): External { return this.acctData!.handle; }

    get isEnabled(): boolean { return this.enabled; }

    get connected(): boolean {
        if (!this.acctData) {
            return false;
        }
        return accounts.is_connected(this.acctData.handle);
    }

    public findAccount() {
        const data = accounts.find(this.username, this.protocol.id);
        if (!data) {
            throw new Error("Account not found");
        }
        this.acctData = data;
        this.enabled = accounts.get_enabled(this.acctData.handle);
    }

    public createNew(password?: string) {
        accounts.new(this.username, this.protocol.id, password);
    }

    public setEnabled(enable: boolean) {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        accounts.set_enabled(this.acctData!.handle, enable);
        this.enabled = enable;
    }

    public sendIM(recipient: string, msg: IBasicProtocolMessage) {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        messaging.sendIM(this.acctData!.handle, recipient, msg.body);
    }

    public sendChat(chatName: string, msg: IBasicProtocolMessage) {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        messaging.sendChat(this.acctData!.handle, chatName, msg.body);
    }

    public getBuddy(user: string): Buddy {
        if (!this.handle) {
            throw Error("No account is binded to this instance. Call findAccount()");
        }
        return buddy.find(this.acctData!.handle, user);
    }

    public getJoinPropertyForRoom(roomName: string, key: string): string|undefined {
        const props = this.joinPropertiesForRooms.get(roomName);
        if (props) {
            return props[key];
        }
    }

    public setJoinPropertiesForRoom(roomName: string, props: IChatJoinProperties) {
        // We kinda need to know the join properties for things like XMPP's handle.
        this.joinPropertiesForRooms.set(roomName, props);
    }

    public isInRoom(roomName: string) {
        return this.joinPropertiesForRooms.has(roomName);
    }

    public joinChat(
        components: IChatJoinProperties,
        purple?: IPurpleInstance,
        timeout: number = 1000,
        setWaiting: boolean = true)
        : Promise<IConversationEvent|void> {
        // XXX: This is extremely bad, but there isn't a way to map "join_properties" of a join
        // room request to the joined-room event, which throws us off quite badly.
        if (setWaiting) {
            this.waitingJoinRoomProperties = components;
        }
        messaging.joinChat(this.handle, components);
        if (purple) {
            return new Promise((resolve, reject) => {
                let cb;
                const timer = setTimeout(reject, timeout);
                cb = (ev: IConversationEvent) => {
                    if (ev.account.username === this.username && ev.account.protocol_id === this.protocol.id) {
                        resolve(ev);
                        purple.removeListener("chat-joined", cb);
                        clearTimeout(timer);
                    }
                };
                purple.on("chat-joined", cb);
            });
        }
        return Promise.resolve();
    }

    public rejectChat(components: IChatJoinProperties) {
        messaging.rejectChat(this.handle, components);
    }

    public getConversation(name: string): Conversation {
        return messaging.findConversation(this.handle, name);
    }

    public passUserInfoResponse(uinfo: IUserInfo) {
        const resolve = this.userAccountInfoPromises.get(uinfo.who);
        if (resolve) {
            resolve()(uinfo);
        }
    }

    public getChatParamsForProtocol(): IChatJoinOptions[] {
        return messaging.chatParams(this.handle, this.protocol.id);
    }

    public getUserInfo(who: string): Promise<IUserInfo> {
        notify.get_user_info(this.handle, who);
        return new Promise ((resolve, reject) => {
            const id = setTimeout(reject, 10000);
            this.userAccountInfoPromises.set(who, () => {
                clearTimeout(id);
                return resolve;
            });
        });
    }

    public eraseWaitingJoinRoomProps() {
        this.waitingJoinRoomProperties = undefined;
    }

    public async getAvatarBuffer(iconPath: string): Promise<{type: string, data: Buffer}> {
        return {
            type: "image/jpeg",
            data: await fs.readFile(iconPath),
        };
    }

    // connect() {
    //     accounts.connect(this.username, this.protocol.id);
    // }
}
