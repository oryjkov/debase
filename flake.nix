{
  description = "SwissALTI3D wingsuit exit-point finder";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        pyenv = pkgs.python3.withPackages (ps: with ps; [
          numpy
          rasterio
          pyproj
          requests
          tqdm
        ]);
      in {
        devShells.default = pkgs.mkShell {
          packages = [ pyenv ];
          shellHook = ''
            export PYTHONPATH="$PWD/src:$PYTHONPATH"
          '';
        };
      });
}
