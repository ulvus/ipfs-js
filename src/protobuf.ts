"use strict";

import { ethers } from "ethers";
import { getUrl } from "./geturl";
import { BaseX } from "@ethersproject/basex";

const INFURA_IPFS_URL = "https://ipfs.infura.io:5001/api/v0/block/get?arg=";

const base58 = new BaseX(
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
);

// https://developers.google.com/protocol-buffers/docs/encoding
enum WireType {
  Varint = 0,
  Fixed64 = 1,
  VarLength = 2,
}

enum SchemaType {
  PBNODE = 1,
  PBLINK = 2,
  UNIXFS = 3,
}

// Protobuf definitions for merkledag node and links:
//    https://github.com/ipfs/go-merkledag/blob/master/pb/merkledag.proto
// Protobuf defintions for unixfs:
//    https://github.com/ipfs/go-unixfs/blob/master/pb/unixfs.proto

type SchemaDefinition = {
  names: Array<string>;
  repeated?: { [key: string]: boolean };
};

const Schemas: { [name: string]: SchemaDefinition } = {
  [SchemaType.PBNODE]: {
    names: ["data", "links"],
    repeated: { links: true },
  },
  [SchemaType.PBLINK]: {
    names: ["hash", "n", "ts"],
  },
  [SchemaType.UNIXFS]: {
    names: ["type", "data", "fs", "bs", "ht", "fo"],
  },
};

class PBNode {
  static parse(data: Uint8Array): Promise<Uint8Array> {
    const schema: SchemaDefinition = Schemas[SchemaType.PBNODE];
    const result = ProtoBuf.parse(data, schema);

    if (result.links) {
      var promises: Array<Promise<Uint8Array>> = [];
      result.links.forEach(function (hash: Uint8Array) {
        promises.push(PBLink.parse(hash));
      });
      return Promise.all(promises).then(function (blocks) {
        return ethers.utils.concat(blocks);
      });
    }
    if (result.data && result.data.constructor === Uint8Array) {
      return Promise.resolve(PBData.parse(result.data));
    }

    throw new Error("Missing links or data");
  }
}

class PBLink {
  static parse(data: Uint8Array): Promise<Uint8Array> {
    const schema: SchemaDefinition = Schemas[SchemaType.PBLINK];
    const result = ProtoBuf.parse(data, schema);
    if (result.hash.length !== 34) {
      throw new Error(`unsupported hash ${ethers.utils.hexlify(result.hash)}`);
    }
    return ProtoBuf.get(base58.encode(result.hash));
  }
}

class PBData {
  static parse(data: Uint8Array): Promise<Uint8Array> {
    const schema: SchemaDefinition = Schemas[SchemaType.UNIXFS];
    const result = ProtoBuf.parse(data, schema);

    if (result.type !== 2) {
      throw new Error("unsupported type");
    }
    if (!result.data) {
      return Promise.resolve(new Uint8Array([]));
    }
    if (result.data.constructor !== Uint8Array) {
      throw new Error("bad Data");
    }
    return Promise.resolve(result.data);
  }
}

export class ProtoBuf {
  /*
   * get from ipfs by multihash
   */
  static get(multihash: string): Promise<Uint8Array> {
    const url = INFURA_IPFS_URL + multihash;

    return getUrl(url).then((res) => {
      const hash = ethers.utils.sha256(res.body);
      const hashFromCID = ethers.utils.hexlify(
        base58.decode(multihash).slice(2)
      );
      if (hash !== hashFromCID) {
        throw new Error("hash mismatch");
      }
      return PBNode.parse(res.body);
    });
  }

  /*
   * put file ipfs
   */
  static put(path: string): Promise<string> {
    return Promise.resolve("TBD");
  }

  static parse(data: Uint8Array, schema: SchemaDefinition): any {
    let tempResult: { [key: string]: Array<any> } = {};
    let result: { [key: string]: any } = {};
    let offset = 0;

    var readVarInt = function () {
      var v = [data[offset] & 0x7f];
      while (data[offset++] & 0x80) {
        if (offset === data.length) {
          throw new Error("buffer overrun");
        }
        v.unshift(data[offset] & 0x7f);
      }
      var result = 0;
      v.forEach(function (v) {
        result = result * 128 + v;
      });
      return result;
    };

    while (offset < data.length) {
      var v = readVarInt();
      const tag = schema.names[(v >>> 3) - 1];
      if (!tag) {
        throw new Error("unknown field - " + v);
      }

      if (!tempResult[tag]) {
        tempResult[tag] = [];
      }
      // now get the wire type from v
      switch (v & 7) {
        // varint
        case WireType.Varint:
          tempResult[tag].push(readVarInt());
          break;

        // bytes
        case WireType.VarLength: {
          var length = readVarInt();
          if (offset + length > data.length) {
            throw new Error("buffer overrun");
          }

          tempResult[tag].push(data.slice(offset, offset + length));
          offset += length;
          break;
        }

        default:
          console.log("unsupported type - " + tag);
          throw new Error("unsupported type - " + tag);
      }
    }

    Object.keys(tempResult).forEach((key: string) => {
      result[key] =
        schema.repeated && schema.repeated[key]
          ? tempResult[key]
          : tempResult[key][0];
    });
    return result;
  }
}
