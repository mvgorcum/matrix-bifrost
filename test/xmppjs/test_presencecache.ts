import * as Chai from "chai";
import { PresenceCache } from "../../src/xmppjs/PresenceCache";
import { jid } from "@xmpp/component";
import { x } from "@xmpp/xml";
const expect = Chai.expect;

const aliceJoin = x("presence", {
    xmlns: "jabber:client",
    to: "bob@xmpp.matrix.org/fakedevice",
    from: "aroom@conf.xmpp.matrix.org/alice",
});

const aliceLeave = x("presence", {
    xmlns: "jabber:client",
    to: "bob@xmpp.matrix.org/fakedevice",
    from: "aroom@conf.xmpp.matrix.org/alice",
    type: "unavailable",
});

const aliceKick = x("presence", {
        xmlns: "jabber:client",
        to: "bob@xmpp.matrix.org/fakedevice",
        from: "aroom@conf.xmpp.matrix.org/alice",
        type: "unavailable",
    },
    x("x", {
        xmlns: "http://jabber.org/protocol/muc#user",
    },
    [
        x("status", {
            code: "307",
        }),
        x("item", undefined, [
            x("actor", {
                nick: "bob",
            }),
            x("reason", undefined, "Didn't like em much"),
        ]),
    ],
));

describe("PresenceCache", () => {
    it("should parse a join message", () => {
        const p = new PresenceCache();
        const delta = p.add(aliceJoin)!;
        expect(delta).to.not.be.undefined;
        expect(delta.changed).to.contain("online");
        expect(delta.changed).to.contain("new");
        expect(delta.error).to.be.null;
        expect(delta.isSelf).to.be.false;
        expect(delta.status!.resource).to.eq("alice");
        const status = p.getStatus("aroom@conf.xmpp.matrix.org/alice");
        expect(status).to.not.be.undefined;
        expect(status!.online).to.be.true;
        expect(status!.ours).to.be.false;
        expect(status!.resource).to.eq("alice");
    });

    it("should parse a leave message", () => {
        const p = new PresenceCache();
        p.add(aliceJoin)!;
        const delta = p.add(aliceLeave)!;
        expect(delta).to.not.be.undefined;
        expect(delta.changed).to.contain("offline");
        expect(delta.error).to.be.null;
        expect(delta.isSelf).to.be.false;
        expect(delta.status!.resource).to.eq("alice");
        const status = p.getStatus("aroom@conf.xmpp.matrix.org/alice");
        expect(status).to.not.be.undefined;
        expect(status!.online).to.be.false;
        expect(status!.ours).to.be.false;
        expect(status!.resource).to.eq("alice");
    });

    it("should parse a kick message", () => {
        const p = new PresenceCache();
        p.add(aliceJoin)!;
        const delta = p.add(aliceKick)!;
        expect(delta).to.not.be.undefined;
        expect(delta.changed).to.contain("kick");
        expect(delta.error).to.be.null;
        expect(delta.isSelf).to.be.false;
        expect(delta.status!.resource).to.eq("alice");
        const status = p.getStatus("aroom@conf.xmpp.matrix.org/alice");
        expect(status).to.not.be.undefined;
        expect(status!.online).to.be.false;
        expect(status!.ours).to.be.false;
        expect(status!.kick!.kicker).to.eq("bob");
        expect(status!.kick!.reason).to.eq("Didn't like em much");
        expect(status!.resource).to.eq("alice");
    });
});
