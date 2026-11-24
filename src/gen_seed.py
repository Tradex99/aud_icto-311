
#!/usr/bin/env python3

import argparse
import getpass
import os
from pathlib import Path

import base58
from mnemonic import Mnemonic
from solders.keypair import Keypair

BASE_DIR = Path(__file__).resolve().parent

SEED_FILE = BASE_DIR / "seed_phrase.txt"
PRIVATE_KEY_FILE = BASE_DIR / "sol_private_key.txt"

DERIVATION_PATH = "m/44'/501'/0'/0'"


def secure_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(content + "\n")
    os.chmod(path, 0o600)


def derive_wallet(phrase):
    mnemo = Mnemonic("english")

    if not mnemo.check(phrase):
        raise ValueError("Invalid BIP-39 recovery phrase.")

    seed = mnemo.to_seed(phrase)

    return Keypair.from_seed_and_derivation_path(
        seed,
        DERIVATION_PATH
    )


def generate_new_wallet():
    mnemo = Mnemonic("english")

    phrase = mnemo.generate(strength=128)

    secure_write(SEED_FILE, phrase)

    print("\nNew 12-word recovery phrase generated.")
    print(f"Saved to: {SEED_FILE}")

    return derive_wallet(phrase)


def derive_existing_wallet():
    phrase = getpass.getpass(
        "\nEnter your 12-word recovery phrase: "
    ).strip()

    return derive_wallet(phrase)


def save_wallet(keypair):
    # Encode the complete 64-byte Solana keypair in Base58
    private_key = base58.b58encode(bytes(keypair)).decode("ascii")

    # Save Base58 private key
    secure_write(PRIVATE_KEY_FILE, private_key)

    # Verify saved key by decoding it again
    with open(PRIVATE_KEY_FILE, "r") as file:
        saved_key = file.read().strip()

    restored = Keypair.from_bytes(base58.b58decode(saved_key))

    if restored.pubkey() != keypair.pubkey():
        raise RuntimeError("Private key verification failed.")

    print("\nSolana wallet created successfully.")
    print("-----------------------------------")
    print(f"Public address: {keypair.pubkey()}")
    print(f"Private key:    {PRIVATE_KEY_FILE}")
    print(f"Format:         Base58")
    print(f"Derivation:     {DERIVATION_PATH}")
    print("-----------------------------------")
    print("Private key saved and verified.")


def main():
    parser = argparse.ArgumentParser(
        description="Generate or derive a Solana wallet."
    )

    parser.add_argument(
        "--sol",
        action="store_true",
        help="Derive wallet from an existing 12-word phrase."
    )

    args = parser.parse_args()

    try:
        if args.sol:
            keypair = derive_existing_wallet()
        else:
            keypair = generate_new_wallet()

        save_wallet(keypair)

    except (ValueError, RuntimeError, OSError) as error:
        print(f"\nError: {error}")


if __name__ == "__main__":
    main()
