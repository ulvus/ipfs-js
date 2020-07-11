"use strict";

import { getUrl } from "./geturl";
import { ethers } from "ethers";
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

/*
class PBLink {
  hash?: Uint8Array;
  name?: string;
  tsize?: number;
}

class PBNode {
  data?: Unixfs;
  links: Array<PBLink>;
}


class Unixfs {
  type: number;
  data?: Uint8Array;
  filesize?: number;
  blocksize?: number;
  hashType?: number;
  fanout?: number;
}
*/

function parseProtoBuf(data: Uint8Array, type: SchemaType): any {
  let tempResult: { [key: string]: Array<any> } = {};
  let result: { [key: string]: any } = {};
  let offset = 0;

  const schema = Schemas[type];
  if (!schema) {
    throw new Error("bad type");
  }

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

const parseData = (data: Uint8Array, type: SchemaType): Promise<any> => {
  var result = parseProtoBuf(data, type);

  switch (type) {
    case SchemaType.PBNODE: {
      if (result.links) {
        var promises: Array<Promise<Uint8Array>> = [];
        result.links.forEach(function (hash: Uint8Array) {
          promises.push(parseData(hash, SchemaType.PBLINK));
        });
        return Promise.all(promises).then(function (blocks) {
          return ethers.utils.concat(blocks);
        });
      }
      if (result.data && result.data.constructor === Uint8Array) {
        return Promise.resolve(parseData(result.data, SchemaType.UNIXFS));
      }
      break;
    }
    case SchemaType.PBLINK:
      if (result.hash.length !== 34) {
        throw new Error(
          `unsupported hash ${ethers.utils.hexlify(result.hash)}`
        );
      }
      return Ipfs.get(base58.encode(result.hash));
    case SchemaType.UNIXFS:
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

  throw new Error("unsupported type");
};

export class Ipfs {
  static get(multihash: string): Promise<any> {
    const url = INFURA_IPFS_URL + multihash;

    return getUrl(url).then((res) => {
      const hash = ethers.utils.sha256(res.body);
      const hashFromCID = ethers.utils.hexlify(
        base58.decode(multihash).slice(2)
      );
      if (hash !== hashFromCID) {
        throw new Error("hash mismatch");
      }
      return parseData(res.body, SchemaType.PBNODE);
    });
  }
}
