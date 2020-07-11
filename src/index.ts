"use strict";

import { ProtoBuf } from "./protobuf";

export class Ipfs {
  static get(multihash: string): Promise<Uint8Array> {
    return ProtoBuf.get(multihash);
  }

  static put(path: string): Promise<string> {
    return ProtoBuf.put(path);
  }
}
