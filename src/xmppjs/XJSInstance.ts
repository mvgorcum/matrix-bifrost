import { EventEmitter } from "events";
import { Logging, MatrixUser, Bridge } from "matrix-appservice-bridge";
import { Element } from "@xmpp/xml";
import { jid, JID } from "@xmpp/jid";
import { IPurpleInstance } from "../purple/IPurpleInstance";
import { Config } from "../Config";
import { PurpleProtocol } from "../purple/PurpleProtocol";
import { IXJSBackendOpts } from "./XJSBackendOpts";
import { XmppJsAccount } from "./XJSAccount";
import { IPurpleAccount } from "../purple/IPurpleAccount";
import { IAccountEvent,
    IChatJoined,
    IReceivedImMsg,
    IConversationEvent,
    IUserStateChanged,
    IChatTyping,
    IGatewayJoin,
    IStoreRemoteUser} from "../purple/PurpleEvents";
import { IBasicProtocolMessage, IMessageAttachment } from "../MessageFormatter";
import { PresenceCache } from "./PresenceCache";
import { Metrics } from "../Metrics";
import { ServiceHandler } from "./ServiceHandler";
import { XJSConnection } from "./XJSConnection";
import { AutoRegistration } from "../AutoRegistration";
import { XmppJsGateway } from "./XJSGateway";
import { IEventRequestData } from "../MatrixTypes";

const xLog = Logging.get("XMPP-conn");
const log = Logging.get("XmppJsInstance");

class XmppProtocol extends PurpleProtocol {
    constructor() {
        super({
            id: "xmpp-js",
            name: "XMPP.js Protocol Plugin",
            homepage: "N/A",
            summary: "Fake purple protocol plugin for xmpp.js",
        }, false, false);
    }

    public getMxIdForProtocol(
            senderId: string,
            domain: string,
            prefix: string = "",
            isGroupChat: boolean = false) {
        const j = jid(senderId);
        /* is not allowed in a JID localpart so it is used as a seperator.
           =2F is /, =40 is @
           We also show the resource first if given, because it's usually the nick
           of a user which is more important than the localpart. */
        const resource = j.resource ? j.resource + "=2f" : "";
        return new MatrixUser(`@${prefix}${resource}${j.local}=40${j.domain}:${domain}`);
    }
}

export const XMPP_PROTOCOL = new XmppProtocol();

export class XmppJsInstance extends EventEmitter implements IPurpleInstance {
    public readonly presenceCache: PresenceCache;
    private serviceHandler: ServiceHandler;
    private xmpp?: any;
    private myAddress!: JID;
    private accounts: Map<string, XmppJsAccount>;
    private seenMessages: Set<string>;
    private canWrite: boolean;
    private defaultRes!: string;
    private connectionWasDropped: boolean;
    private bufferedMessages: Array<{xmlMsg: Element, resolve: (res: Promise<void>) => void}>;
    private autoRegister?: AutoRegistration;
    private bridge!: Bridge;
    private xmppGateway: XmppJsGateway;
    constructor(private config: Config) {
        super();
        this.canWrite = false;
        this.accounts = new Map();
        this.bufferedMessages = [];
        this.seenMessages = new Set();
        this.presenceCache = new PresenceCache();
        this.serviceHandler = new ServiceHandler(this);
        this.xmppGateway = new XmppJsGateway(this, config.bridge);
        this.connectionWasDropped = false;
    }

    get gateway() {
        return this.xmppGateway;
    }

    get defaultResource(): string {
        return this.defaultRes;
    }

    get xmppAddress(): JID {
        return this.myAddress;
    }

    public preStart(bridge: Bridge, autoRegister?: AutoRegistration) {
        this.autoRegister = autoRegister;
        this.bridge = bridge;
    }

    public createPurpleAccount(username) {
        return new XmppJsAccount(username, this.defaultRes, this, "");
    }

    public xmppWriteToStream(xmlMsg: any) {
        if (this.canWrite) {
            return this.xmpp.write(xmlMsg);
        }
        const p = new Promise((resolve) => {
            this.bufferedMessages.push({xmlMsg, resolve});
        });
        return p;
    }

    public xmppAddSentMessage(id: string) { this.seenMessages.add(id); }

    public isWaitingToJoin(j: JID): string|undefined {
        for (const acct of this.accounts.values()) {
            if (acct.waitingToJoin.has(`${j.local}@${j.domain}`)) {
                return acct.remoteId + "/" + acct.resource;
            }
        }
        return;
    }

    public getBuddyFromChat(conv: any, buddy: string): any {
        return undefined;
    }

    public async start(): Promise<void> {
        const config = this.config.purple;
        const opts = config.backendOpts as IXJSBackendOpts;
        if (!opts || !opts.service || !opts.domain || !opts.password) {
            throw Error("Missing opts for xmpp: service, domain, password");
        }
        this.defaultRes = opts.defaultResource ? opts.defaultResource : "matrix-bridge";
        log.info(`Starting new XMPP component instance to ${opts.service} using domain ${opts.domain}`);
        const xmpp = XJSConnection.connect({
            service: opts.service,
            domain: opts.domain,
            password: opts.password,
        });
        xmpp.on("error", (err) => {
            xLog.error(err);
        });
        xmpp.on("offline", () => {
            xLog.info("gone offline.");
        });
        xmpp.on("stanza", (stanza) => {
            try {
                this.onStanza(stanza);
            } catch (ex) {
                log.error("Failed to handle stanza:", ex);
            }
        });

        xmpp.on("online", (address) => {
            xLog.info("gone online as " + address);
            this.myAddress = address;
            this.canWrite = true;
            log.info(`flushing ${this.bufferedMessages.length} buffered messages`);
            if (this.connectionWasDropped) {
                log.warn("Connection was dropped, attempting reconnect..");
                this.presenceCache.clear();
                for (const account of this.accounts.values()) {
                    account.reconnectToRooms();
                }
            }
            while (this.bufferedMessages.length) {
                if (!this.canWrite) {
                    return;
                }
                const msg = this.bufferedMessages.splice(0, 1)[0];
                msg.resolve(this.xmpp.write(msg.xmlMsg));
            }
        });

        // Debug
        xmpp.on("status", (status) => {
          if (status === "disconnecting" || status === "disconnected") {
              this.canWrite = false;
          }
          if (status === "disconnect") {
              log.error("Connection to XMPP server was lost..");
              this.connectionWasDropped = true;
          }
          xLog.debug("status:", status);
        });

        if (opts.logRawStream) {
            xmpp.on("input", (input) => {
                xLog.debug("RX:", input);
            });
            xmpp.on("output", (output) => {
                xLog.debug("TX:", output);
            });
        }
        await xmpp.start();
        this.xmpp = xmpp;
    }

    public signInAccounts(mxidUsernames: {[mxid: string]: string}) {
        Object.keys(mxidUsernames).forEach((mxid) => {
            this.getAccount(mxidUsernames[mxid], XMPP_PROTOCOL.id, mxid);
        });
    }

    public getAccountForJid(aJid: JID): XmppJsAccount|undefined {
        log.debug(aJid);
        if (aJid.domain === this.myAddress.domain) {
            log.debug(aJid.local, [...this.accounts.keys()]);
            return this.accounts.get(aJid.toString());
        }
        // TODO: Handle MUC based JIDs?
        return;
    }

    public getAccount(username: string, protocolId: string, mxid: string): IPurpleAccount|null {
        const uLower = username.toLowerCase();
        log.debug("Getting account", username);
        if (protocolId !== "xmpp-js") {
            return null;
        }
        if (this.accounts.has(uLower)) {
            return this.accounts.get(uLower)!;
        }
        this.accounts.set(uLower, new XmppJsAccount(username, this.defaultRes, this, mxid));
        // Components don't "connect", so just emit this once we've created it.
        this.emit("account-signed-on", {
            eventName: "account-signed-on",
            account: {
                protocol_id: XMPP_PROTOCOL.id,
                username,
            },
        } as IAccountEvent);
        return this.accounts.get(username)!;
    }

    public getProtocol(id: string): PurpleProtocol|undefined {
        if (id === "xmpp-js") { return XMPP_PROTOCOL; }
    }

    public getProtocols(): PurpleProtocol[] {
        return [XMPP_PROTOCOL];
    }

    public findProtocol(nameOrId: string): PurpleProtocol|undefined {
        if (nameOrId.toLowerCase() === "xmpp-js") { return XMPP_PROTOCOL; }
    }

    public getNickForChat(conv: any): string {
        throw new Error("Not supported.");
    }

    public needsDedupe() {
        return false;
    }

    public needsAccountLock() {
        return false;
    }

    public getUsernameFromMxid(
            mxid: string,
            prefix: string = ""): {username: string, protocol: PurpleProtocol} {
        // This is for GHOST accts
        let uName = new MatrixUser(mxid, false).localpart;
        const match = /@(.+.+=2f)?(.+=40)(.+)/.exec(uName);
        if (!match) {
            throw Error("Username didn't match");
        }
        const resource = match[1].substr(prefix.length, match[0].length - (prefix.length + "=2f".length));
        const localpart = match[2].substr(0, match[1].length - "=40".length);
        const domain = match[3];
        uName = uName.replace(prefix, "");
        // XXX: Gah, underscore spittling is hard with a resource.
        uName = uName.replace(/\=3a/g, ":");
        const splitParts = uName.split("_");
        const username =
            `${splitParts.slice(0, splitParts.length - 1 ).join("_")}@${splitParts[splitParts.length - 1]}`;
        return {username, protocol: XMPP_PROTOCOL};
    }

    private generateIdforMsg(stanza: Element) {
        const body = stanza.getChildText("body");

        if (body) {
            return Buffer.from(`${stanza.getAttr("from")}${body}`).toString("base64");
        }

        return Buffer.from(stanza.children.map((c) => c.toString()).join("")).toString("base64");
    }

    private async onStanza(stanza: Element) {
        const startedAt = Date.now();
        const id = stanza.attrs.id = stanza.attrs.id || this.generateIdforMsg(stanza);
        if (this.seenMessages.has(id)) {
            return;
        }
        this.seenMessages.add(id);
        log.debug("Stanza:", stanza.toJSON());
        const from = stanza.attrs.from ? jid(stanza.attrs.from) : null;
        const to = stanza.attrs.to ? jid(stanza.attrs.to) : null;

        const isOurs = to !== null && to.domain === this.myAddress.domain;
        log.info(`Got from=${from} to=${to} isOurs=${isOurs}`);
        const alias = isOurs && to!.local.startsWith("#") && this.serviceHandler.parseAliasFromJID(to!) || null;
        try {
            if (isOurs) {
                if (stanza.is("iq") && stanza.getAttr("type") === "get") {
                    await this.serviceHandler.handleIq(stanza, this.bridge.getIntent());
                    return;
                }
                // If it wasn't an IQ or a room, then it's probably a PM.
            }

            if (alias && stanza.is("presence")) {
                this.gateway.handleStanza(stanza, alias);
                return;
            }

            if (stanza.is("message")) {
                this.handleMessageStanza(stanza, alias);
            } else if (stanza.is("presence")) {
                this.handlePresenceStanza(stanza, alias);
            } else if (stanza.is("iq") &&
                ["result", "error"].includes(stanza.getAttr("type")) &&
                stanza.attrs.id) {
                this.emit("iq." + id, stanza);
            } else if (stanza.is("iq") && stanza.getAttr("type") === "get" && isOurs) {
                this.serviceHandler.handleIq(stanza, this.bridge.getIntent());
            }
        } catch (ex) {
            log.warn("Failed to handle stanza: ", ex);
            Metrics.requestOutcome(true, Date.now() - startedAt, "fail");
        }
        Metrics.requestOutcome(true, Date.now() - startedAt, "success");
    }

    private async handleMessageStanza(stanza: Element, alias: string|null) {
        if (!stanza.attrs.from || !stanza.attrs.to) {
            return;
        }
        const to = jid(stanza.attrs.to)!;
        let localAcct = this.accounts.get(`${to!.local}@${to!.domain}`)!;
        let from = jid(stanza.attrs.from);
        let convName = `${from.local}@${from.domain}`;
        if (alias) {
            log.debug("This is an alias room, seeing if the user has a handle jid");
            convName = `${to.local}@${to.domain}`;
            stanza.attrs.from = this.gateway.getRoomJidForRealJid(convName, stanza.attrs.from) || stanza.attrs.from;
            log.debug(stanza.attrs.from);
            from = jid(stanza.attrs.from) ;
            this.gateway.reflectXMPPMessage(stanza);
        }
        const type = stanza.attrs.type;
        const chatState = stanza.getChildByAttr("xmlns", "http://jabber.org/protocol/chatstates");

        if (!localAcct && !alias) {
            // No local account, attempt to autoregister it?
            if (this.autoRegister) {
                try {
                    const acct = await this.autoRegister.reverseRegisterUser(stanza.attrs.to, XMPP_PROTOCOL)!;
                    localAcct = this.getAccount(acct.remoteId, XMPP_PROTOCOL.id, "") as XmppJsAccount;
                } catch (ex) {
                    log.warn("Failed to autoregister user:", ex);
                    return;
                }
            } else {
                log.warn("Could not handle message, auto registration is disabled");
            }
        } else if (alias) {
            // This is a gateway, so setup a fake account.
            localAcct = {
                remoteId: `${to!.local}@${to!.domain}`,
            } as any;
        } else {
            localAcct.xmppBumpLastStanzaTs(convName);
        }
        if (chatState) {
            if (chatState.is("composing") || chatState.is("active") || chatState.is("paused")) {
                const eventName = type === "groupchat" ? "chat-typing" : "im-typing";
                this.emit(eventName, {
                    eventName,
                    conv: {
                        name: convName,
                    },
                    account: {
                        protocol_id: XMPP_PROTOCOL.id,
                        username: localAcct.remoteId,
                    },
                    sender: stanza.attrs.from,
                    typing: chatState.is("composing"),
                } as IChatTyping);
            }
        }

        // XXX: Must be a better way to handle this.
        const subject = stanza.getChildText("subject");
        if (subject && type === "groupchat") {
            // Room names in XMPP are basically just local@domain,
            // and so is sort of implied by the from address. We will emit
            // a room name change at the same time as the subject. The
            // RoomHandler code shoudln't attempt to change the name unless it is wrong.
            this.emit("chat-topic", {
                conv: {
                    name: convName,
                },
                account: {
                    protocol_id: XMPP_PROTOCOL.id,
                    username: localAcct.remoteId,
                },
                sender: stanza.attrs.from,
                string: subject,
                isGateway: false,
            });
        }

        const body = stanza.getChildText("body");
        if (!body) {
            log.debug("Don't know how to handle a message without children");
            return;
        }
        const attachments: IMessageAttachment[] = [];
        // https://xmpp.org/extensions/xep-0066.html#x-oob
        const attachmentWrapper = stanza.getChild("x");
        if (attachmentWrapper && attachmentWrapper.attrs.xmlns === "jabber:x:oob") {
            const url = attachmentWrapper.getChild("url");
            if (url) {
                attachments.push({
                    uri: url.text(),
                } as IMessageAttachment);
            }
        }

        const message = {
            body,
            formatted: [ ],
            id: stanza.attrs.id,
            opts: {
                attachments,
            },
        } as IBasicProtocolMessage;

        let html = stanza.getChild("html");
        if (html) {
            html = html.getChild("body") || html;
            message.formatted!.push({
                type: "html",
                body: html.toString(),
            });
        }

        if (type === "groupchat") {
            log.debug("Emitting group message", message);
            this.emit("received-chat-msg", {
                eventName: "received-chat-msg",
                sender: stanza.attrs.from,
                message,
                conv: {
                    // Don't include the handle
                    name: convName,
                },
                account: {
                    protocol_id: XMPP_PROTOCOL.id,
                    username: localAcct.remoteId,
                },
                isGateway: false,
            } as IReceivedImMsg);
        } else if (type === "chat" || type === "normal") {
            if (!localAcct) {
                log.debug(`Handling a message to ${convName}, who does not yet exist.`);
            }
            log.debug("Emitting chat message", message);
            const isMucPm = stanza.getChildByAttr("xmlns", "http://jabber.org/protocol/muc#user");
            this.emit("received-im-msg", {
                eventName: "received-im-msg",
                sender: isMucPm ? from.toString() : `${from.local}@${from.domain}`,
                message,
                account: {
                    protocol_id: XMPP_PROTOCOL.id,
                    username: localAcct.remoteId,
                },
            } as IReceivedImMsg);
        }
    }

    private handlePresenceStanza(stanza: Element, gatewayAlias: string|null) {
        const to = jid(stanza.getAttr("to"));
        // XMPP is case insensitive.
        const localAcct = this.accounts.get(`${to.local}@${to.domain}`);
        const from = jid(stanza.getAttr("from"));
        const convName = `${from.local}@${from.domain}`;

        const delta = this.presenceCache.add(stanza);
        if (!delta) {
            return;
        }

        if (delta.error && localAcct) {
            if (delta.error === "conflict") {
                log.info(`${from.toString()} conflicted with another user, attempting to fix`);
                localAcct.xmppRetryJoin(from).catch((err) => {
                    log.error("Failed to retry join", err);
                });
                return;
            }
            log.error(`Failed to join ${from} ${to} :`, delta.errorMsg);
        }

        const username = localAcct ? localAcct.remoteId : to.toString();

        // emit a chat-joined-new if an account was joining this room.
        if (delta.isSelf && localAcct && localAcct.waitingToJoin.has(convName)) {
            localAcct.waitingToJoin.delete(convName);
            this.emit("store-remote-user", {
                mxId: localAcct.mxId,
                remoteId: `${convName}/${localAcct.roomHandles.get(convName)}`,
                protocol_id: XMPP_PROTOCOL.id,
            } as IStoreRemoteUser);
            this.emit(`chat-joined-new`, {
                eventName: "chat-joined-new",
                purpleAccount: localAcct,
                conv: {
                    name: convName,
                },
                account: {
                    protocol_id: XMPP_PROTOCOL.id,
                    username,
                },
                join_properties: {
                    room: from.local,
                    server: from.domain,
                    handle: from.resource,
                },
            } as IChatJoined);
        }

        if (delta.changed.includes("offline")) {
            if (delta.isSelf) {
                // XXX: Should we attempt to reconnect/kick the user?
                return;
            }
            const wasKicked = delta.status!.kick;
            let kicker;
            if (wasKicked && wasKicked.kicker) {
                kicker = `${convName}/${wasKicked.kicker}`;
            }

            this.emit("chat-user-left", {
                conv: {
                    name: convName,
                },
                account: {
                    protocol_id: XMPP_PROTOCOL.id,
                    username,
                },
                sender: stanza.attrs.from,
                state: "left",
                kicker,
                reason: wasKicked ? wasKicked.reason : delta.status!.status,
                gatewayAlias,
            } as IUserStateChanged);
            return;
        }

        if (delta.changed.includes("online")) {
            if (delta.status && delta.isSelf && localAcct) {
                // Always emit this.
                this.emit("chat-joined", {
                    eventName: "chat-joined",
                    conv: {
                        name: convName,
                    },
                    account: {
                        protocol_id: XMPP_PROTOCOL.id,
                        username,
                    },
                } as IConversationEvent);
                return;
            }
            if (delta.status && !delta.status.ours) {
                if (this.isWaitingToJoin(to) === from.toString()) {
                    // An account is waiting to join this room, so hold off on the
                    return;
                }
                this.emit("chat-user-joined", {
                    conv: {
                        name: convName,
                    },
                    account: {
                        protocol_id: XMPP_PROTOCOL.id,
                        username,
                    },
                    sender: stanza.attrs.from,
                    state: "joined",
                    gatewayAlias,
                } as IUserStateChanged);
            }
        }
    }
}
