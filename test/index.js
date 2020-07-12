"use strict";

const assert = require("assert");
const { Ipfs } = require("../dist/index");
const ethers = require("ethers");

describe("block get", function () {
  it("should return data", async function () {
    const data = await Ipfs.get(
      "Qmd2V777o5XvJbYMeMb8k2nU5f8d3ciUQ5YpYuWhzv8iDj"
    );
    const regex = new RegExp("meeseek");
    assert.ok(regex.test(ethers.utils.toUtf8String(data)), "meeseek not found");
    assert.ok(data.length > 0, "hash has length");
  });

  it("should return data from large file", async function () {
    this.timeout(120000);
    const data = await Ipfs.get(
      "QmQAsdPwfERkwHZ11Bz6cL85o6VU5cPThh4HPJXR2mDL1r"
    );

    const expectedHash = '0xa67e3e74436d7497973cf5865faa801ae8faf3dab580c4a953222b7b0e4475a3';
    const calculatedHash = ethers.utils.keccak256(data);
    assert.equal(calculatedHash, expectedHash, "content mismatch");
    assert.ok(data.length > 0, "hash has length");
  });
});
