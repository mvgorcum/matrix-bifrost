/**
 * A collection of interfaces that may be emitted by PurpleInterface
 */

import { IPurpleAccount } from "./IPurpleAccount";
import { IBasicProtocolMessage } from "../MessageFormatter";
import { IGatewayRoom } from "../GatewayHandler";
import { IRemoteUserAccountRemote } from "../StoreTypes";

export interface IChatJoinProperties {[key: string]: string; }

export interface IEventBody {
    eventName: string;
}

export interface IAccountMinimal {
    protocol_id: string;
    username: string;
}

export interface IConversationMinimal {
    name: string;
}

export interface IAccountEvent extends IEventBody {
    account: any|IAccountMinimal;
}

export interface IConversationEvent extends IAccountEvent {
    conv: any | IConversationMinimal;
}

// received-im-msg
export interface IReceivedImMsg extends IConversationEvent {
    sender: string;
    message: IBasicProtocolMessage;
}

export interface IChatInvite extends IAccountEvent {
    sender: string;
    message: string;
    room_name: string;
    join_properties: IChatJoinProperties;
}

export interface IChatJoined extends IConversationEvent {
    purpleAccount: IPurpleAccount;
    join_properties: IChatJoinProperties;
}

export interface IUserStateChanged extends IConversationEvent {
    sender: string;
    state: "joined"|"left";
    kicker: string|undefined;
    reason?: string;
    gatewayAlias: string|null;
    id: string;
}

export interface IChatStringState extends IConversationEvent {
    sender: string;
    string: string;
}

export interface IUserInfo extends IAccountEvent {
    [key: string]: string|IAccountMinimal;
    who: string;
}

export interface IChatTyping extends IConversationEvent {
    sender: string;
    typing: boolean;
}

export interface IGatewayRequest {
    roomAlias: string;
    result: (err: Error|null, res?: any) => void;
}

export interface IGatewayRoomQuery extends IGatewayRequest {
    onlyCheck: boolean;
    result: (err: Error|null, res?: string|IGatewayRoom) => void;
}

export interface IGatewayJoin {
    sender: string;
    protocol_id: string;
    join_id: string;
    roomAlias: string;
    room_name: string;
}

export interface IStoreRemoteUser {
    mxId: string;
    remoteId: string;
    protocol_id: string;
    data?: any;
}
