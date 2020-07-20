"use strict";

import { ethers } from "ethers";
import { getUrl } from "./geturl";
import { BaseX } from "@ethersproject/basex";
import { Varint } from "./varint";

const INFURA_IPFS_URL = "https://ipfs.infura.io:5001/api/v0/block";

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
    const url = `${INFURA_IPFS_URL}/get?arg=${multihash}`;

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
  static put(data: Uint8Array): Promise<any> {
    const url = `${INFURA_IPFS_URL}/put`;

    // simple unixfs type
    // varint of type file 2, data, filesize, blocksize
    const type = Varint.encode((1 << 3) | 2);
    //const length = Varint.encode(data.length);
    const body = Buffer.concat([
      Buffer.from(`--boundary 
Content-Disposition: form-data;

`),
      Buffer.from(type),
      Buffer.from(`--boundary--
`),
    ]);

    const contentType = `multipart/form-data;boundary="boundary"`;
    const options = {
      method: "POST",
      body,
      headers: {
        "Content-Type": contentType,
      },
    };
    return getUrl(url, options).then((res) => {
      return JSON.parse(ethers.utils.toUtf8String(res.body));
    });
  }

  static parse(data: Uint8Array, schema: SchemaDefinition): any {
    let tempResult: { [key: string]: Array<any> } = {};
    let result: { [key: string]: any } = {};
    let offset = 0;

    while (offset < data.length) {
      let varint = Varint.decode(data, offset);
      const v = varint.value;
      offset += varint.length;
      const tag = schema.names[(v >>> 3) - 1];

      if (!tag) {
        console.log("data", data, ethers.utils.toUtf8String(data));
        throw new Error("unknown field - " + v);
      }

      if (!tempResult[tag]) {
        tempResult[tag] = [];
      }
      // now get the wire type from v
      switch (v & 7) {
        // varint
        case WireType.Varint:
          varint = Varint.decode(data, offset);
          tempResult[tag].push(varint.value);
          offset += varint.length;
          break;

        // bytes
        case WireType.VarLength: {
          varint = Varint.decode(data, offset);
          const length = varint.value;
          if (offset + length > data.length) {
            throw new Error("buffer overrun");
          }
          offset += varint.length;

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
